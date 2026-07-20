alter table public.rooms
  add column if not exists ai_request_id uuid,
  add column if not exists ai_player_id uuid references public.players(id) on delete set null,
  add column if not exists ai_started_at timestamptz,
  add column if not exists ai_remaining_seconds integer;

create or replace function public.join_room(p_code text, p_nickname text, p_token_hash text)
returns uuid language plpgsql security definer set search_path=public as $$
declare r rooms; joined_id uuid; next_seat smallint; active_count integer;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not (r.status='waiting' and r.paused_at is null) and not (r.status='playing' and r.pause_reason='WAITING_FOR_PLAYERS') then raise exception 'ROOM_NOT_WAITING'; end if;
  select count(*) into active_count from public.players where room_id=r.id and is_active;
  if active_count >= r.max_players then raise exception 'ROOM_FULL'; end if;
  select n into next_seat from generate_series(1,r.max_players) n where not exists (select 1 from public.players where room_id=r.id and seat_number=n and is_active) order by n limit 1;
  select id into joined_id from public.players where room_id=r.id and seat_number=next_seat and not is_active order by left_at desc nulls last limit 1;
  if joined_id is null then
    insert into public.players(room_id,seat,seat_number,nickname,token_hash) values(r.id,cast(next_seat as text),next_seat,coalesce(nullif(trim(p_nickname),''),'xxx'),p_token_hash) returning id into joined_id;
  else
    update public.players set nickname=coalesce(nullif(trim(p_nickname),''),'xxx'),token_hash=p_token_hash,is_active=true,left_at=null,last_seen_at=clock_timestamp(),rematch_ready=false where id=joined_id;
  end if;
  active_count := active_count+1;
  update public.rooms set paused_at=case when active_count >= 2 and pause_reason='WAITING_FOR_PLAYERS' then null else paused_at end,
    pause_reason=case when active_count >= 2 and pause_reason='WAITING_FOR_PLAYERS' then null else pause_reason end,
    turn_deadline=case when status='playing' and active_count >= 2 and pause_reason='WAITING_FOR_PLAYERS' then clock_timestamp()+make_interval(secs=>coalesce(paused_turn_seconds,60)) else turn_deadline end,
    paused_turn_seconds=case when active_count >= 2 and pause_reason='WAITING_FOR_PLAYERS' then null else paused_turn_seconds end,
    scheduled_destroy_at=null,version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return joined_id;
end $$;

create or replace function public.begin_guess(
  p_code text, p_token_hash text, p_request_id uuid, p_expected_version bigint
) returns bigint language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; remaining_seconds integer;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if r.ai_request_id = p_request_id and r.ai_player_id = actor.id then return r.version; end if;
  if r.status <> 'playing' or r.paused_at is not null or r.ai_request_id is not null or r.current_player_id <> actor.id then raise exception 'NOT_YOUR_TURN'; end if;
  if r.version <> p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
  if r.turn_deadline is null or r.turn_deadline <= clock_timestamp() then raise exception 'TURN_EXPIRED'; end if;
  remaining_seconds := greatest(1, ceil(extract(epoch from (r.turn_deadline-clock_timestamp())))::integer);
  update public.rooms set ai_request_id=p_request_id,ai_player_id=actor.id,ai_started_at=clock_timestamp(),
    ai_remaining_seconds=remaining_seconds,turn_deadline=null,version=version+1,updated_at=clock_timestamp()
    where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return r.version;
end $$;

create or replace function public.cancel_guess(p_code text, p_token_hash text, p_request_id uuid)
returns bigint language plpgsql security definer set search_path=public as $$
declare r rooms; actor players;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if r.ai_request_id <> p_request_id or r.ai_player_id <> actor.id then return r.version; end if;
  update public.rooms set ai_request_id=null,ai_player_id=null,ai_started_at=null,
    turn_deadline=case when status='playing' and paused_at is null then clock_timestamp()+make_interval(secs=>coalesce(ai_remaining_seconds,60)) else null end,
    ai_remaining_seconds=null,version=version+1,updated_at=clock_timestamp()
    where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return r.version;
end $$;

create or replace function public.commit_guess(
  p_code text, p_token_hash text, p_request_id uuid, p_expected_version bigint,
  p_normalized_word text, p_display_word text, p_similarity integer
) returns jsonb language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; next_actor players; existing guesses; inserted guesses; active_count integer;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  select * into existing from public.guesses where room_id=r.id and request_id=p_request_id;
  if found then return jsonb_build_object('idempotent',true,'similarity',existing.similarity,'version',r.version); end if;
  if r.status <> 'playing' or r.paused_at is not null or r.current_player_id <> actor.id then raise exception 'NOT_YOUR_TURN'; end if;
  if r.ai_request_id <> p_request_id or r.ai_player_id <> actor.id then raise exception 'GUESS_NOT_LOCKED'; end if;
  if r.version <> p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
  select * into existing from public.guesses where room_id=r.id and normalized_word=p_normalized_word;
  if found then
    update public.rooms set ai_request_id=null,ai_player_id=null,ai_started_at=null,
      turn_deadline=clock_timestamp()+make_interval(secs=>coalesce(ai_remaining_seconds,60)),ai_remaining_seconds=null,
      version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
    perform public.touch_room_event(p_code,r.version);
    return jsonb_build_object('repeated',true,'similarity',existing.similarity,'version',r.version);
  end if;
  insert into public.guesses(room_id,player_id,request_id,turn_number,normalized_word,display_word,similarity,hint)
    values(r.id,actor.id,p_request_id,r.turn_number,p_normalized_word,p_display_word,p_similarity,'') returning * into inserted;
  if p_similarity = 100 then
    update public.rooms set status='finished',winner_id=actor.id,current_player_id=null,turn_deadline=null,
      ai_request_id=null,ai_player_id=null,ai_started_at=null,ai_remaining_seconds=null,version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into r.version;
  else
    select count(*) into active_count from public.players where room_id=r.id and is_active;
    select * into next_actor from public.players where id=public.next_active_player_id(r.id,actor.seat_number);
    if next_actor.id is null then select * into next_actor from public.players where id=public.first_active_player_id(r.id); end if;
    update public.rooms set current_player_id=next_actor.id,turn_number=turn_number+1,
      turn_deadline=case when active_count >= 2 then clock_timestamp()+interval '60 seconds' else null end,
      paused_at=case when active_count < 2 then clock_timestamp() else null end,
      pause_reason=case when active_count < 2 then 'WAITING_FOR_PLAYERS' else null end,
      paused_turn_seconds=case when active_count < 2 then 60 else null end,
      ai_request_id=null,ai_player_id=null,ai_started_at=null,ai_remaining_seconds=null,version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into r.version;
  end if;
  perform public.touch_room_event(p_code,r.version);
  return jsonb_build_object('idempotent',false,'similarity',inserted.similarity,'version',r.version,'isCorrect',inserted.similarity=100);
end $$;

create or replace function public.leave_room(p_code text, p_token_hash text)
returns bigint language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; next_host players; next_turn_player_id uuid; current_version bigint; active_count integer; saved_seconds integer;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  saved_seconds := case when r.turn_deadline is null then coalesce(r.ai_remaining_seconds,60) else greatest(1,ceil(extract(epoch from (r.turn_deadline-clock_timestamp())))::integer) end;
  update public.players set is_active=false,left_at=clock_timestamp(),last_seen_at=clock_timestamp(),rematch_ready=false where id=actor.id;
  select count(*) into active_count from public.players where room_id=r.id and is_active;
  if active_count = 0 then
    update public.rooms set paused_at=clock_timestamp(),pause_reason='EMPTY_ROOM',scheduled_destroy_at=clock_timestamp()+interval '5 minutes',
      paused_turn_seconds=saved_seconds,current_player_id=null,turn_deadline=null,ai_request_id=null,ai_player_id=null,ai_started_at=null,ai_remaining_seconds=null,
      version=version+1,updated_at=clock_timestamp() where id=r.id returning version into current_version;
  else
    if actor.id = r.host_player_id then
      select * into next_host from public.players where room_id=r.id and is_active order by seat_number limit 1;
      update public.rooms set host_player_id=next_host.id,scheduled_destroy_at=null where id=r.id;
    end if;
    if r.current_player_id = actor.id then
      next_turn_player_id := public.next_active_player_id(r.id,actor.seat_number);
      if next_turn_player_id is null then next_turn_player_id := public.first_active_player_id(r.id); end if;
    else next_turn_player_id := r.current_player_id;
    end if;
    update public.rooms set current_player_id=next_turn_player_id,
      turn_number=case when r.current_player_id=actor.id and r.status='playing' then turn_number+1 else turn_number end,
      paused_at=case when active_count < 2 and r.status='playing' then clock_timestamp() else null end,
      pause_reason=case when active_count < 2 and r.status='playing' then 'WAITING_FOR_PLAYERS' else null end,
      paused_turn_seconds=case when active_count < 2 and r.status='playing' then saved_seconds else null end,
      turn_deadline=case when r.status='playing' and active_count >= 2 then clock_timestamp()+interval '60 seconds' else null end,
      ai_request_id=null,ai_player_id=null,ai_started_at=null,ai_remaining_seconds=null,
      version=version+1,updated_at=clock_timestamp() where id=r.id returning version into current_version;
  end if;
  perform public.touch_room_event(p_code,current_version);
  return current_version;
end $$;

create or replace function public.list_public_rooms()
returns table(code text, category text, difficulty text, status text, max_players smallint, player_count bigint, updated_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  perform public.cleanup_expired_rooms();
  return query
    select r.code,r.category,r.difficulty,case when r.pause_reason='WAITING_FOR_PLAYERS' then 'paused' else r.status::text end,r.max_players,
      count(p.id) filter (where p.is_active),r.updated_at
    from public.rooms r left join public.players p on p.room_id=r.id
    where r.visibility='public' and r.scheduled_destroy_at is null
      and (r.status='waiting' or (r.status='playing' and r.pause_reason='WAITING_FOR_PLAYERS'))
    group by r.id having count(p.id) filter (where p.is_active) < r.max_players
    order by r.updated_at desc limit 30;
end $$;

revoke all on function public.join_room(text,text,text) from public,anon,authenticated;
revoke all on function public.begin_guess(text,text,uuid,bigint) from public,anon,authenticated;
revoke all on function public.cancel_guess(text,text,uuid) from public,anon,authenticated;
revoke all on function public.commit_guess(text,text,uuid,bigint,text,text,integer) from public,anon,authenticated;
revoke all on function public.leave_room(text,text) from public,anon,authenticated;
revoke all on function public.list_public_rooms() from public,anon,authenticated;
grant execute on function public.join_room(text,text,text) to service_role;
grant execute on function public.begin_guess(text,text,uuid,bigint) to service_role;
grant execute on function public.cancel_guess(text,text,uuid) to service_role;
grant execute on function public.commit_guess(text,text,uuid,bigint,text,text,integer) to service_role;
grant execute on function public.leave_room(text,text) to service_role;
grant execute on function public.list_public_rooms() to service_role;

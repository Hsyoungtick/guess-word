alter table public.rooms
  add column if not exists scheduled_destroy_at timestamptz;

create or replace function public.cleanup_expired_rooms()
returns integer language plpgsql security definer set search_path=public as $$
declare deleted_count integer;
begin
  delete from public.room_events e
  using public.rooms r
  where e.room_code = r.code
    and r.scheduled_destroy_at is not null
    and r.scheduled_destroy_at <= clock_timestamp()
    and not exists (select 1 from public.players p where p.room_id = r.id and p.is_active);

  delete from public.rooms r
  where r.scheduled_destroy_at is not null
    and r.scheduled_destroy_at <= clock_timestamp()
    and not exists (select 1 from public.players p where p.room_id = r.id and p.is_active);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end $$;

create or replace function public.advance_expired_turn_locked(p_room_id uuid, p_room rooms)
returns bigint language plpgsql security definer set search_path = public as $$
declare current_seat smallint; next_id uuid; next_deadline timestamptz;
begin
  if p_room.status <> 'playing' or p_room.paused_at is not null or p_room.turn_deadline is null or p_room.turn_deadline > clock_timestamp() then
    return p_room.version;
  end if;
  select seat_number into current_seat from public.players where id=p_room.current_player_id;
  next_id := public.next_active_player_id(p_room_id, current_seat);
  if next_id is null then next_id := public.first_active_player_id(p_room_id); end if;
  if next_id is null then return p_room.version; end if;
  next_deadline := clock_timestamp() + interval '60 seconds';
  update public.rooms set current_player_id=next_id, turn_number=turn_number+1,
    turn_deadline=next_deadline, version=version+1, updated_at=clock_timestamp()
    where id=p_room_id;
  perform public.touch_room_event(p_room.code, p_room.version+1);
  return p_room.version+1;
end $$;

create or replace function public.sync_room_state(p_code text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; host_last_seen timestamptz; host_active boolean; current_version bigint;
begin
  perform public.cleanup_expired_rooms();
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;

  select p.last_seen_at, p.is_active into host_last_seen, host_active
  from public.players p where p.id=r.host_player_id;

  if r.status = 'playing' and r.paused_at is null and (not coalesce(host_active, false) or host_last_seen < clock_timestamp() - interval '45 seconds') then
    update public.rooms set paused_at=clock_timestamp(), pause_reason='HOST_OFFLINE',
      paused_turn_seconds=case when turn_deadline is null then null else greatest(1, ceil(extract(epoch from (turn_deadline-clock_timestamp())))::integer) end,
      turn_deadline=null, version=version+1, updated_at=clock_timestamp() where id=r.id returning version into current_version;
    perform public.touch_room_event(p_code, current_version);
    return current_version;
  end if;

  if r.paused_at is not null and r.pause_reason in ('HOST_OFFLINE','HOST_LEFT') and coalesce(host_active, false) and host_last_seen > r.paused_at then
    update public.rooms set paused_at=null, pause_reason=null,
      turn_deadline=case when status='playing' then clock_timestamp()+make_interval(secs=>coalesce(paused_turn_seconds,60)) else null end,
      paused_turn_seconds=null, version=version+1, updated_at=clock_timestamp() where id=r.id returning version into current_version;
    perform public.touch_room_event(p_code, current_version);
    return current_version;
  end if;

  if r.status='playing' and r.paused_at is null and r.turn_deadline <= clock_timestamp() then
    return public.advance_expired_turn_locked(r.id, r);
  end if;
  return r.version;
end $$;

create or replace function public.heartbeat_room(p_code text, p_token_hash text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; actor players; current_version bigint;
begin
  perform public.cleanup_expired_rooms();
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  update public.players set last_seen_at=clock_timestamp() where id=actor.id;
  if actor.id=r.host_player_id and r.paused_at is not null and r.pause_reason in ('HOST_OFFLINE','HOST_LEFT') then
    update public.rooms set paused_at=null, pause_reason=null, scheduled_destroy_at=null,
      turn_deadline=case when status='playing' then clock_timestamp()+make_interval(secs=>coalesce(paused_turn_seconds,60)) else null end,
      paused_turn_seconds=null, version=version+1, updated_at=clock_timestamp() where id=r.id returning version into current_version;
    perform public.touch_room_event(p_code,current_version);
    return current_version;
  end if;
  update public.rooms set updated_at=clock_timestamp() where id=r.id returning version into current_version;
  perform public.touch_room_event(p_code,current_version);
  return current_version;
end $$;

create or replace function public.start_game(p_code text, p_token_hash text, p_answer_ciphertext text, p_answer_word_id uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; active_count integer;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found or r.status <> 'waiting' or r.paused_at is not null then raise exception 'ROOM_NOT_WAITING'; end if;
  if not exists (select 1 from public.players where room_id=r.id and id=r.host_player_id and token_hash=p_token_hash and is_active) then raise exception 'UNAUTHORIZED'; end if;
  select count(*) into active_count from public.players where room_id=r.id and is_active;
  if active_count < 2 then raise exception 'ROOM_NOT_FULL'; end if;
  if not exists (select 1 from public.word_bank where id=p_answer_word_id) then raise exception 'WORD_NOT_FOUND'; end if;
  update public.rooms set status='playing', answer_ciphertext=p_answer_ciphertext, answer_word_id=p_answer_word_id,
    current_player_id=public.first_active_player_id(r.id), turn_number=1,
    turn_deadline=clock_timestamp()+interval '60 seconds', version=version+1,
    winner_id=null, paused_at=null, pause_reason=null, scheduled_destroy_at=null, updated_at=clock_timestamp()
    where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return r.version;
end $$;

create or replace function public.commit_guess(
  p_code text, p_token_hash text, p_request_id uuid, p_expected_version bigint,
  p_normalized_word text, p_display_word text, p_similarity integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; actor players; next_actor players; existing guesses; inserted guesses;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  select * into existing from public.guesses where room_id=r.id and request_id=p_request_id;
  if found then return jsonb_build_object('idempotent',true,'similarity',existing.similarity,'version',r.version); end if;
  if r.status <> 'playing' or r.paused_at is not null or r.current_player_id <> actor.id then raise exception 'NOT_YOUR_TURN'; end if;
  if r.turn_deadline <= clock_timestamp() then raise exception 'TURN_EXPIRED'; end if;
  if r.version <> p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
  select * into existing from public.guesses where room_id=r.id and normalized_word=p_normalized_word;
  if found then return jsonb_build_object('repeated',true,'similarity',existing.similarity,'version',r.version); end if;
  insert into public.guesses(room_id,player_id,request_id,turn_number,normalized_word,display_word,similarity,hint)
    values(r.id,actor.id,p_request_id,r.turn_number,p_normalized_word,p_display_word,p_similarity,'') returning * into inserted;
  if p_similarity = 100 then
    update public.rooms set status='finished',winner_id=actor.id,current_player_id=null,turn_deadline=null,version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into r.version;
  else
    select * into next_actor from public.players where id=public.next_active_player_id(r.id,actor.seat_number);
    if next_actor.id is null then select * into next_actor from public.players where id=public.first_active_player_id(r.id); end if;
    update public.rooms set current_player_id=next_actor.id,turn_number=turn_number+1,turn_deadline=clock_timestamp()+interval '60 seconds',version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into r.version;
  end if;
  perform public.touch_room_event(p_code,r.version);
  return jsonb_build_object('idempotent',false,'similarity',inserted.similarity,'version',r.version,'isCorrect',inserted.similarity=100,'nextPlayerId',case when inserted.similarity=100 then null else next_actor.id end,'turnDeadline',case when inserted.similarity=100 then null else (select turn_deadline from public.rooms where id=r.id) end);
end $$;

create or replace function public.leave_room(p_code text, p_token_hash text)
returns bigint language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; next_host players; next_turn_player_id uuid; current_version bigint; active_count integer;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;

  update public.players set is_active=false,left_at=clock_timestamp(),last_seen_at=clock_timestamp(),rematch_ready=false where id=actor.id;
  select count(*) into active_count from public.players where room_id=r.id and is_active;

  if active_count = 0 then
    update public.rooms set paused_at=clock_timestamp(),pause_reason='EMPTY_ROOM',scheduled_destroy_at=clock_timestamp()+interval '5 minutes',
      paused_turn_seconds=case when turn_deadline is null then null else greatest(1,ceil(extract(epoch from (turn_deadline-clock_timestamp())))::integer) end,
      current_player_id=null,turn_deadline=null,version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into current_version;
  else
    if actor.id = r.host_player_id then
      select * into next_host from public.players where room_id=r.id and is_active order by seat_number limit 1;
      update public.rooms set host_player_id=next_host.id, paused_at=null, pause_reason=null, scheduled_destroy_at=null, updated_at=clock_timestamp()
        where id=r.id;
    end if;

    if r.current_player_id = actor.id and r.status = 'playing' then
      next_turn_player_id := public.next_active_player_id(r.id, actor.seat_number);
      if next_turn_player_id is null then next_turn_player_id := public.first_active_player_id(r.id); end if;
      update public.rooms set current_player_id=next_turn_player_id,turn_number=turn_number+1,turn_deadline=clock_timestamp()+interval '60 seconds',version=version+1,updated_at=clock_timestamp()
        where id=r.id returning version into current_version;
    else
      update public.rooms set version=version+1,updated_at=clock_timestamp() where id=r.id returning version into current_version;
    end if;
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
    select r.code, r.category, r.difficulty, r.status::text, r.max_players,
      count(p.id) filter (where p.is_active) as player_count, r.updated_at
    from public.rooms r
    left join public.players p on p.room_id=r.id
    where r.visibility='public' and r.status='waiting' and r.scheduled_destroy_at is null
    group by r.id
    having count(p.id) filter (where p.is_active) < r.max_players
    order by r.updated_at desc
    limit 30;
end $$;

revoke all on function public.cleanup_expired_rooms() from public, anon, authenticated;
revoke all on function public.advance_expired_turn_locked(uuid, rooms) from public, anon, authenticated;
revoke all on function public.sync_room_state(text) from public, anon, authenticated;
revoke all on function public.heartbeat_room(text, text) from public, anon, authenticated;
revoke all on function public.start_game(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.commit_guess(text, text, uuid, bigint, text, text, integer) from public, anon, authenticated;
revoke all on function public.leave_room(text, text) from public, anon, authenticated;
revoke all on function public.list_public_rooms() from public, anon, authenticated;
grant execute on function public.cleanup_expired_rooms() to service_role;
grant execute on function public.sync_room_state(text) to service_role;
grant execute on function public.heartbeat_room(text, text) to service_role;
grant execute on function public.start_game(text, text, text, uuid) to service_role;
grant execute on function public.commit_guess(text, text, uuid, bigint, text, text, integer) to service_role;
grant execute on function public.leave_room(text, text) to service_role;
grant execute on function public.list_public_rooms() to service_role;

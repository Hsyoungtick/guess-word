create unique index if not exists guesses_room_id_normalized_word_key on public.guesses(room_id, normalized_word);

create or replace function public.join_room(p_code text, p_nickname text, p_token_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r rooms; joined_id uuid;
begin
  select * into r from rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if r.status <> 'waiting' then raise exception 'ROOM_NOT_WAITING'; end if;
  if (select count(*) from players where room_id=r.id) >= 2 then raise exception 'ROOM_FULL'; end if;
  insert into players(room_id,seat,nickname,token_hash) values(r.id,'B',p_nickname,p_token_hash) returning id into joined_id;
  update rooms set version=version+1, updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform touch_room_event(p_code,r.version);
  return joined_id;
end $$;

create or replace function public.commit_guess(
  p_code text, p_token_hash text, p_request_id uuid, p_expected_version bigint,
  p_normalized_word text, p_display_word text, p_similarity integer, p_hint text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; actor players; next_actor players; existing guesses; inserted guesses;
begin
  select * into r from rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from players where room_id=r.id and token_hash=p_token_hash;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  select * into existing from guesses where room_id=r.id and request_id=p_request_id;
  if found then return jsonb_build_object('idempotent',true,'similarity',existing.similarity,'hint',existing.hint,'version',r.version); end if;
  if r.status <> 'playing' or r.current_player_id <> actor.id then raise exception 'NOT_YOUR_TURN'; end if;
  if r.version <> p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
  if r.turn_deadline <= clock_timestamp() then raise exception 'TURN_EXPIRED'; end if;
  insert into guesses(room_id,player_id,request_id,turn_number,normalized_word,display_word,similarity,hint)
    values(r.id,actor.id,p_request_id,r.turn_number,p_normalized_word,p_display_word,p_similarity,p_hint) returning * into inserted;
  if p_similarity = 100 then
    update rooms set status='finished',winner_id=actor.id,current_player_id=null,turn_deadline=null,version=version+1,updated_at=clock_timestamp()
      where id=r.id returning version into r.version;
  else
    select * into next_actor from players where room_id=r.id and id<>actor.id;
    update rooms set current_player_id=next_actor.id,turn_number=turn_number+1,turn_deadline=clock_timestamp()+interval '30 seconds',
      version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
  end if;
  perform touch_room_event(p_code,r.version);
  return jsonb_build_object('idempotent',false,'similarity',inserted.similarity,'hint',inserted.hint,'version',r.version,
    'isCorrect',inserted.similarity=100,'nextPlayerId',case when inserted.similarity=100 then null else next_actor.id end,
    'turnDeadline',case when inserted.similarity=100 then null else (select turn_deadline from rooms where id=r.id) end);
end $$;

revoke all on function public.join_room(text, text, text) from public, anon, authenticated;
revoke all on function public.commit_guess(text, text, uuid, bigint, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.join_room(text, text, text) to service_role;
grant execute on function public.commit_guess(text, text, uuid, bigint, text, text, integer, text) to service_role;
revoke all on public.room_events from public, anon, authenticated;

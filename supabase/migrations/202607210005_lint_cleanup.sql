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
    turn_deadline=clock_timestamp()+interval '30 seconds', version=version+1,
    winner_id=null, paused_at=null, pause_reason=null, updated_at=clock_timestamp()
    where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return r.version;
end $$;

create or replace function public.process_timeout(p_code text, p_token_hash text, p_expected_version bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  perform 1 from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if r.status <> 'playing' or r.paused_at is not null or r.turn_deadline > clock_timestamp() then return r.version; end if;
  if p_expected_version is not null and r.version <> p_expected_version then return r.version; end if;
  return public.advance_expired_turn_locked(r.id,r);
end $$;

revoke all on function public.start_game(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.start_game(text, text, text, uuid) to service_role;
revoke all on function public.process_timeout(text, text, bigint) from public, anon, authenticated;
grant execute on function public.process_timeout(text, text, bigint) to service_role;

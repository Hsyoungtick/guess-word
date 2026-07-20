create or replace function public.sync_room_state(p_code text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; host_last_seen timestamptz; host_active boolean; current_version bigint; active_count integer;
begin
  perform public.cleanup_expired_rooms();
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;

  if r.ai_request_id is not null and r.ai_started_at < clock_timestamp()-interval '45 seconds' then
    update public.rooms set ai_request_id=null,ai_player_id=null,ai_started_at=null,
      turn_deadline=case when paused_at is null then clock_timestamp()+make_interval(secs=>coalesce(ai_remaining_seconds,60)) else null end,
      ai_remaining_seconds=null,version=version+1,updated_at=clock_timestamp() where id=r.id returning * into r;
    perform public.touch_room_event(p_code,r.version);
  end if;

  select count(*) into active_count from public.players where room_id=r.id and is_active;
  if r.status = 'playing' and r.paused_at is null and active_count < 2 then
    update public.rooms set paused_at=clock_timestamp(), pause_reason='WAITING_FOR_PLAYERS',
      paused_turn_seconds=case when turn_deadline is null then coalesce(ai_remaining_seconds,60) else greatest(1,ceil(extract(epoch from (turn_deadline-clock_timestamp())))::integer) end,
      turn_deadline=null, version=version+1, updated_at=clock_timestamp() where id=r.id returning version into current_version;
    perform public.touch_room_event(p_code,current_version);
    return current_version;
  end if;

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

revoke all on function public.sync_room_state(text) from public,anon,authenticated;
grant execute on function public.sync_room_state(text) to service_role;

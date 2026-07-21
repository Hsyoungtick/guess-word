create or replace function public.cleanup_expired_rooms()
returns integer language plpgsql security definer set search_path=public as $$
declare deleted_count integer;
begin
  update public.players p set is_active=false,left_at=coalesce(left_at,clock_timestamp())
  where p.is_active and p.last_seen_at < clock_timestamp()-interval '30 seconds';

  update public.rooms r set paused_at=coalesce(paused_at,clock_timestamp()),
    pause_reason=case when status='playing' then 'WAITING_FOR_PLAYERS' else pause_reason end,
    paused_turn_seconds=case when turn_deadline is null then coalesce(paused_turn_seconds,60) else greatest(1,ceil(extract(epoch from (turn_deadline-clock_timestamp())))::integer) end,
    turn_deadline=null,
    scheduled_destroy_at=case when not exists (select 1 from public.players p where p.room_id=r.id and p.is_active) then coalesce(scheduled_destroy_at,clock_timestamp()+interval '5 minutes') else scheduled_destroy_at end,
    updated_at=clock_timestamp()
  where r.status in ('waiting','playing')
    and not exists (select 1 from public.players p where p.room_id=r.id and p.is_active);

  delete from public.room_events e
  using public.rooms r
  where e.room_code=r.code and r.scheduled_destroy_at is not null and r.scheduled_destroy_at <= clock_timestamp()
    and not exists (select 1 from public.players p where p.room_id=r.id and p.is_active);
  delete from public.rooms r
  where r.scheduled_destroy_at is not null and r.scheduled_destroy_at <= clock_timestamp()
    and not exists (select 1 from public.players p where p.room_id=r.id and p.is_active);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end $$;

do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='guess-word-cleanup-expired-rooms';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule('guess-word-cleanup-expired-rooms','30 seconds',$job$select public.cleanup_expired_rooms();$job$);
exception when undefined_table then
  raise notice 'pg_cron is unavailable; cleanup will run on lobby activity';
end $$;

create or replace function public.resume_room(p_code text, p_token_hash text)
returns bigint language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; active_count integer; current_version bigint;
begin
  perform public.cleanup_expired_rooms();
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash;
  if not found then raise exception 'RESUME_NOT_AVAILABLE'; end if;
  update public.players set is_active=true,left_at=null,last_seen_at=clock_timestamp(),rematch_ready=false where id=actor.id;
  select count(*) into active_count from public.players where room_id=r.id and is_active;
  update public.rooms set scheduled_destroy_at=null,
    paused_at=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then null else paused_at end,
    pause_reason=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then null else pause_reason end,
    turn_deadline=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then clock_timestamp()+make_interval(secs=>coalesce(paused_turn_seconds,60)) else turn_deadline end,
    paused_turn_seconds=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then null else paused_turn_seconds end,
    version=version+1,updated_at=clock_timestamp() where id=r.id returning version into current_version;
  perform public.touch_room_event(p_code,current_version);
  return current_version;
end $$;

create or replace function public.list_public_rooms()
returns table(code text, category text, difficulty text, status text, max_players smallint, player_count bigint, updated_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  perform public.cleanup_expired_rooms();
  return query
    select r.code,r.category,r.difficulty,
      case when count(p.id) filter (where p.is_active)=0 or r.pause_reason='WAITING_FOR_PLAYERS' then 'paused' else r.status::text end,
      r.max_players,count(p.id) filter (where p.is_active),r.updated_at
    from public.rooms r left join public.players p on p.room_id=r.id
    where r.visibility='public'
      and (r.status='waiting' or (r.status='playing' and r.pause_reason='WAITING_FOR_PLAYERS') or r.scheduled_destroy_at is not null)
    group by r.id
    having count(p.id) filter (where p.is_active) < r.max_players
    order by r.updated_at desc limit 30;
end $$;

revoke all on function public.cleanup_expired_rooms() from public,anon,authenticated;
revoke all on function public.resume_room(text,text) from public,anon,authenticated;
grant execute on function public.cleanup_expired_rooms() to service_role;
grant execute on function public.resume_room(text,text) to service_role;

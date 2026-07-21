create or replace function public.random_player_name()
returns text language sql volatile as $$
  select '玩家' || string_agg(substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 1 + floor(random() * 26)::int, 1), '')
  from generate_series(1, 6);
$$;

alter table public.players alter column nickname set default public.random_player_name();

create or replace function public.join_room(p_code text, p_nickname text, p_token_hash text)
returns uuid language plpgsql security definer set search_path=public as $$
declare r rooms; joined_id uuid; next_seat smallint; active_count integer; player_name text;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not (r.status='waiting' and r.paused_at is null) and not (r.status='playing' and r.pause_reason='WAITING_FOR_PLAYERS') then raise exception 'ROOM_NOT_WAITING'; end if;
  select count(*) into active_count from public.players where room_id=r.id and is_active;
  if active_count >= r.max_players then raise exception 'ROOM_FULL'; end if;
  player_name := coalesce(nullif(trim(p_nickname),''), public.random_player_name());
  select n into next_seat from generate_series(1,r.max_players) n where not exists (select 1 from public.players where room_id=r.id and seat_number=n and is_active) order by n limit 1;
  select id into joined_id from public.players where room_id=r.id and seat_number=next_seat and not is_active order by left_at desc nulls last limit 1;
  if joined_id is null then
    insert into public.players(room_id,seat,seat_number,nickname,token_hash) values(r.id,cast(next_seat as text),next_seat,player_name,p_token_hash) returning id into joined_id;
  else
    update public.players set nickname=player_name,token_hash=p_token_hash,is_active=true,left_at=null,last_seen_at=clock_timestamp(),rematch_ready=false where id=joined_id;
  end if;
  active_count := active_count+1;
  update public.rooms set paused_at=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then null else paused_at end,
    pause_reason=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then null else pause_reason end,
    turn_deadline=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then clock_timestamp()+make_interval(secs=>coalesce(paused_turn_seconds,60)) else turn_deadline end,
    paused_turn_seconds=case when status='playing' and pause_reason='WAITING_FOR_PLAYERS' and active_count >= 2 then null else paused_turn_seconds end,
    scheduled_destroy_at=null,version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return joined_id;
end $$;

revoke all on function public.random_player_name() from public,anon,authenticated;
revoke all on function public.join_room(text,text,text) from public,anon,authenticated;
grant execute on function public.random_player_name() to service_role;
grant execute on function public.join_room(text,text,text) to service_role;

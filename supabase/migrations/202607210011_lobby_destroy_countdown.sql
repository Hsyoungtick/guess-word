drop function if exists public.list_public_rooms();

create function public.list_public_rooms()
returns table(code text, category text, difficulty text, status text, max_players smallint, player_count bigint, updated_at timestamptz, destroy_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  perform public.cleanup_expired_rooms();
  return query
    select r.code,r.category,r.difficulty,
      case when count(p.id) filter (where p.is_active)=0 or r.pause_reason='WAITING_FOR_PLAYERS' then 'paused' else r.status::text end,
      r.max_players,count(p.id) filter (where p.is_active),r.updated_at,r.scheduled_destroy_at
    from public.rooms r left join public.players p on p.room_id=r.id
    where r.visibility='public'
      and (r.status='waiting' or (r.status='playing' and r.pause_reason='WAITING_FOR_PLAYERS') or r.scheduled_destroy_at is not null)
    group by r.id
    having count(p.id) filter (where p.is_active) < r.max_players
    order by r.updated_at desc limit 30;
end $$;

revoke all on function public.list_public_rooms() from public,anon,authenticated;
grant execute on function public.list_public_rooms() to service_role;

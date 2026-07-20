create or replace function public.process_timeout(p_code text, p_token_hash text, p_expected_version bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; actor players;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if r.status <> 'playing' or r.paused_at is not null or r.turn_deadline > clock_timestamp() then return r.version; end if;
  if p_expected_version is not null and r.version <> p_expected_version then return r.version; end if;
  return public.advance_expired_turn_locked(r.id,r);
end $$;

revoke all on function public.process_timeout(text, text, bigint) from public, anon, authenticated;
grant execute on function public.process_timeout(text, text, bigint) to service_role;

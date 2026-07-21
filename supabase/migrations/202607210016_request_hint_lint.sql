create or replace function public.request_hint(p_code text, p_token_hash text)
returns smallint language plpgsql security definer set search_path=public as $$
declare r rooms; next_level smallint;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not exists (select 1 from public.players where room_id=r.id and token_hash=p_token_hash and is_active) then raise exception 'UNAUTHORIZED'; end if;
  if r.status <> 'playing' then raise exception 'ROOM_NOT_PLAYING'; end if;
  if r.answer_word_id is null then raise exception 'ANSWER_MISSING'; end if;
  next_level := least(2, coalesce(r.hint_level,0) + 1);
  update public.rooms set hint_level=next_level, version=version+1, updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return next_level;
end $$;

revoke all on function public.request_hint(text,text) from public,anon,authenticated;
grant execute on function public.request_hint(text,text) to service_role;

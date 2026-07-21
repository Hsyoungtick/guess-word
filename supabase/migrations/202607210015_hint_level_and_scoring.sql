alter table public.rooms add column if not exists hint_level smallint not null default 0 check (hint_level between 0 and 2);

drop function if exists public.claim_word(text,text);

create function public.claim_word(p_category text, p_difficulty text)
returns table(word_id uuid, answer text, category text)
language plpgsql security definer set search_path = public as $$
declare selected_id uuid; selected_word text; selected_category text;
begin
  select w.id, w.word, w.category into selected_id, selected_word, selected_category
  from public.word_bank w
  where w.difficulty = p_difficulty
    and (p_category = '随机' or w.category = p_category)
  order by w.times_used asc, random()
  limit 1
  for update skip locked;
  if selected_id is null then raise exception 'WORD_BANK_EMPTY'; end if;
  update public.word_bank set times_used=times_used+1, last_used_at=clock_timestamp() where id=selected_id;
  return query select selected_id, selected_word, selected_category;
end $$;

create or replace function public.request_hint(p_code text, p_token_hash text)
returns smallint language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; next_level smallint;
begin
  select * into r from public.rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from public.players where room_id=r.id and token_hash=p_token_hash and is_active;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if r.status <> 'playing' then raise exception 'ROOM_NOT_PLAYING'; end if;
  if r.answer_word_id is null then raise exception 'ANSWER_MISSING'; end if;
  next_level := least(2, coalesce(r.hint_level,0) + 1);
  update public.rooms set hint_level=next_level, version=version+1, updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform public.touch_room_event(p_code,r.version);
  return next_level;
end $$;

revoke all on function public.claim_word(text,text) from public,anon,authenticated;
revoke all on function public.request_hint(text,text) from public,anon,authenticated;
grant execute on function public.claim_word(text,text) to service_role;
grant execute on function public.request_hint(text,text) to service_role;

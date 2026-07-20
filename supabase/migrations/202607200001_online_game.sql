create extension if not exists pgcrypto;

create type public.room_status as enum ('waiting', 'playing', 'finished');
create type public.player_seat as enum ('A', 'B');

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  status public.room_status not null default 'waiting',
  category text not null,
  difficulty text not null,
  answer_ciphertext text,
  current_player_id uuid,
  turn_deadline timestamptz,
  turn_number bigint not null default 0,
  version bigint not null default 1,
  winner_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  seat public.player_seat not null,
  nickname text not null check (char_length(nickname) between 1 and 20),
  token_hash text not null,
  last_seen_at timestamptz not null default clock_timestamp(),
  rematch_ready boolean not null default false,
  unique (room_id, seat),
  unique (room_id, token_hash)
);

alter table public.rooms add constraint rooms_current_player_fk foreign key (current_player_id) references public.players(id);
alter table public.rooms add constraint rooms_winner_fk foreign key (winner_id) references public.players(id);

create table public.guesses (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id),
  request_id uuid not null,
  turn_number bigint not null,
  normalized_word text not null,
  display_word text not null,
  similarity integer not null check (similarity between 0 and 100),
  hint text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (room_id, request_id),
  unique (room_id, normalized_word)
);

create table public.room_events (
  room_code text primary key,
  version bigint not null,
  changed_at timestamptz not null default clock_timestamp()
);

create or replace function public.reject_guess_mutation() returns trigger language plpgsql as $$
begin
  if new.similarity <> old.similarity or new.normalized_word <> old.normalized_word then
    raise exception 'guess score and normalized word are immutable';
  end if;
  return new;
end $$;
create trigger guesses_immutable before update on public.guesses for each row execute function public.reject_guess_mutation();

create or replace function public.touch_room_event(p_code text, p_version bigint) returns void language sql security definer set search_path = public as $$
  insert into room_events(room_code, version, changed_at) values (p_code, p_version, clock_timestamp())
  on conflict (room_code) do update set version = excluded.version, changed_at = excluded.changed_at;
$$;

create or replace function public.start_game(p_code text, p_token_hash text, p_answer_ciphertext text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; host players;
begin
  select * into r from rooms where code = p_code for update;
  if not found or r.status <> 'waiting' then raise exception 'ROOM_NOT_WAITING'; end if;
  select * into host from players where room_id = r.id and seat = 'A' and token_hash = p_token_hash;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if (select count(*) from players where room_id = r.id) <> 2 then raise exception 'ROOM_NOT_FULL'; end if;
  update rooms set status='playing', answer_ciphertext=p_answer_ciphertext, current_player_id=host.id,
    turn_number=1, turn_deadline=clock_timestamp() + interval '30 seconds', version=version+1,
    winner_id=null, updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform touch_room_event(p_code, r.version);
  return r.version;
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
  select * into existing from guesses where room_id=r.id and normalized_word=p_normalized_word;
  if found then return jsonb_build_object('repeated',true,'similarity',existing.similarity,'hint',existing.hint,'version',r.version); end if;
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

create or replace function public.process_timeout(p_code text, p_token_hash text, p_expected_version bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rooms; actor players; next_actor players;
begin
  select * into r from rooms where code=p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  select * into actor from players where room_id=r.id and token_hash=p_token_hash;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if r.status <> 'playing' or r.turn_deadline > clock_timestamp() then return r.version; end if;
  if p_expected_version is not null and r.version <> p_expected_version then return r.version; end if;
  select * into next_actor from players where room_id=r.id and id<>r.current_player_id;
  update rooms set current_player_id=next_actor.id,turn_number=turn_number+1,turn_deadline=clock_timestamp()+interval '30 seconds',
    version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
  perform touch_room_event(p_code,r.version);
  return r.version;
end $$;

create or replace function public.request_rematch(p_code text, p_token_hash text)
returns boolean language plpgsql security definer set search_path=public as $$
declare r rooms; actor players; ready_count integer;
begin
  select * into r from rooms where code=p_code for update;
  if not found or r.status <> 'finished' then raise exception 'ROOM_NOT_FINISHED'; end if;
  select * into actor from players where room_id=r.id and token_hash=p_token_hash;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  update players set rematch_ready=true, last_seen_at=clock_timestamp() where id=actor.id;
  select count(*) into ready_count from players where room_id=r.id and rematch_ready;
  if ready_count = 2 then
    delete from guesses where room_id=r.id;
    update players set rematch_ready=false where room_id=r.id;
    update rooms set status='waiting',answer_ciphertext=null,current_player_id=null,turn_deadline=null,
      turn_number=0,winner_id=null,version=version+1,updated_at=clock_timestamp() where id=r.id returning version into r.version;
    perform touch_room_event(p_code,r.version);
    return true;
  end if;
  return false;
end $$;

create or replace function public.process_all_expired_turns() returns integer language plpgsql security definer set search_path=public as $$
declare item record; changed integer := 0; next_id uuid;
begin
  for item in select * from rooms where status='playing' and turn_deadline<=clock_timestamp() for update skip locked loop
    select id into next_id from players where room_id=item.id and id<>item.current_player_id;
    update rooms set current_player_id=next_id,turn_number=turn_number+1,turn_deadline=clock_timestamp()+interval '30 seconds',version=version+1,updated_at=clock_timestamp() where id=item.id;
    perform touch_room_event(item.code,item.version+1); changed := changed+1;
  end loop;
  return changed;
end $$;

alter table rooms enable row level security;
alter table players enable row level security;
alter table guesses enable row level security;
alter table room_events enable row level security;
revoke all on rooms, players, guesses from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.touch_room_event(text, bigint) to service_role;
grant execute on function public.start_game(text, text, text) to service_role;
grant execute on function public.commit_guess(text, text, uuid, bigint, text, text, integer, text) to service_role;
grant execute on function public.process_timeout(text, text, bigint) to service_role;
grant execute on function public.request_rematch(text, text) to service_role;
grant execute on function public.process_all_expired_turns() to service_role;

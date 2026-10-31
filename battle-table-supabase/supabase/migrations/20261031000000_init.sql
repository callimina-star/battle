-- Battle Table: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Safe to run once on a fresh project.

-- ============ Tables ============
create table public.rooms (
  id         text primary key check (id ~ '^[a-z0-9-]{3,40}$'),
  name       text not null default 'Untitled table' check (char_length(name) between 1 and 60),
  map        jsonb not null,
  combat     jsonb not null default '{"active": false, "round": 1, "turnId": null}',
  bg_rev     int  not null default 0,
  created_at timestamptz not null default now()
);

-- Map picture lives apart from the room so live updates stay small.
create table public.room_bg (
  room_id  text primary key references public.rooms(id) on delete cascade,
  data_url text not null check (char_length(data_url) < 300000)
);

-- DM secret (stored hashed) and the list of people who hold DM rights. Never readable from the browser.
create table public.room_secrets (
  room_id     text primary key references public.rooms(id) on delete cascade,
  secret_hash text not null
);
create table public.room_dms (
  room_id text not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  primary key (room_id, user_id)
);

create table public.tokens (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null references public.rooms(id) on delete cascade,
  owner      uuid not null,
  name       text not null check (char_length(name) between 1 and 40),
  kind       text not null default 'pc' check (kind in ('pc', 'ally', 'foe')),
  color      text not null default '#8d99a6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  c          int  not null default 0 check (c between 0 and 39),
  r          int  not null default 0 check (r between 0 and 39),
  hp         int  not null default 0 check (hp between 0 and 999),
  max_hp     int  not null default 0 check (max_hp between 0 and 999),
  init       int  check (init between -20 and 60),
  mod        int  not null default 0 check (mod between -10 and 20),
  hidden     boolean not null default false,
  at         bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index tokens_room_idx on public.tokens (room_id);

-- The DM's map library for each table.
create table public.saved_maps (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null references public.rooms(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  map        jsonb not null,
  created_at timestamptz not null default now()
);
create index saved_maps_room_idx on public.saved_maps (room_id);

-- ============ Helpers ============
create or replace function public.is_dm(p_room text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_dms where room_id = p_room and user_id = auth.uid());
$$;

-- Create a new table. The browser sends a random secret; only its hash is kept.
create or replace function public.create_room(p_id text, p_name text, p_secret text, p_map jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if char_length(p_secret) < 16 then raise exception 'secret too short'; end if;
  insert into public.rooms (id, name, map) values (p_id, p_name, p_map);
  insert into public.room_secrets (room_id, secret_hash) values (p_id, encode(sha256(convert_to(p_secret, 'utf8')), 'hex'));
  insert into public.room_dms (room_id, user_id) values (p_id, auth.uid());
end $$;

-- Become DM on a table by presenting its secret (the DM link). Works from any device.
create or replace function public.claim_dm(p_room text, p_secret text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if not exists (select 1 from public.room_secrets
                 where room_id = p_room and secret_hash = encode(sha256(convert_to(p_secret, 'utf8')), 'hex')) then
    return false;
  end if;
  insert into public.room_dms (room_id, user_id) values (p_room, auth.uid()) on conflict do nothing;
  return true;
end $$;

-- A player ends their own turn. Only the owner of the token whose turn it is may call it.
create or replace function public.player_next_turn(p_room text, p_turn uuid, p_round int)
returns boolean language plpgsql security definer set search_path = public as $$
declare cur jsonb; cur_round int; cur_owner uuid;
begin
  select combat into cur from public.rooms where id = p_room;
  if cur is null or coalesce((cur->>'active')::boolean, false) = false then return false; end if;
  select owner into cur_owner from public.tokens where id = nullif(cur->>'turnId', '')::uuid and room_id = p_room;
  if cur_owner is distinct from auth.uid() then return false; end if;
  if not exists (select 1 from public.tokens where id = p_turn and room_id = p_room) then return false; end if;
  cur_round := coalesce((cur->>'round')::int, 1);
  if p_round < cur_round or p_round > cur_round + 1 then return false; end if;
  update public.rooms
     set combat = jsonb_build_object('active', true, 'round', p_round, 'turnId', p_turn)
   where id = p_room;
  return true;
end $$;

-- Keep tables tidy: cap tokens per room and never let a token change room or owner.
create or replace function public.tokens_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.tokens where room_id = new.room_id) >= 150 then
      raise exception 'too many tokens on this table';
    end if;
  else
    if new.room_id <> old.room_id or new.owner <> old.owner then
      raise exception 'room and owner cannot change';
    end if;
  end if;
  return new;
end $$;
create trigger tokens_guard_ins before insert on public.tokens for each row execute function public.tokens_guard();
create trigger tokens_guard_upd before update on public.tokens for each row execute function public.tokens_guard();

-- ============ Who may do what (Row Level Security) ============
alter table public.rooms        enable row level security;
alter table public.room_bg      enable row level security;
alter table public.room_secrets enable row level security;
alter table public.room_dms     enable row level security;
alter table public.tokens       enable row level security;
alter table public.saved_maps   enable row level security;

-- Everyone signed in (anonymous visitors count) can read a table they know the code of.
create policy rooms_read on public.rooms for select to authenticated using (true);
create policy rooms_dm_update on public.rooms for update to authenticated
  using (public.is_dm(id)) with check (public.is_dm(id));
create policy rooms_dm_delete on public.rooms for delete to authenticated using (public.is_dm(id));

create policy bg_read on public.room_bg for select to authenticated using (true);
create policy bg_dm_write on public.room_bg for all to authenticated
  using (public.is_dm(room_id)) with check (public.is_dm(room_id));

-- Tokens: hidden ones are visible only to the DM and their owner.
create policy tokens_read on public.tokens for select to authenticated
  using (not hidden or owner = auth.uid() or public.is_dm(room_id));
create policy tokens_insert on public.tokens for insert to authenticated
  with check (public.is_dm(room_id) or (owner = auth.uid() and kind = 'pc' and hidden = false));
create policy tokens_update on public.tokens for update to authenticated
  using (public.is_dm(room_id) or (owner = auth.uid() and kind = 'pc'))
  with check (public.is_dm(room_id) or (owner = auth.uid() and kind = 'pc' and hidden = false));
create policy tokens_delete on public.tokens for delete to authenticated
  using (public.is_dm(room_id) or (owner = auth.uid() and kind = 'pc'));

create policy maps_dm_all on public.saved_maps for all to authenticated
  using (public.is_dm(room_id)) with check (public.is_dm(room_id));

-- room_secrets and room_dms have no policies, so the browser can never read or write them directly.
revoke all on public.room_secrets from anon, authenticated;
revoke all on public.room_dms     from anon, authenticated;

-- Only signed-in visitors (including anonymous ones) may call the functions.
revoke execute on function public.create_room(text, text, text, jsonb) from public, anon;
revoke execute on function public.claim_dm(text, text)                 from public, anon;
revoke execute on function public.player_next_turn(text, uuid, int)    from public, anon;
revoke execute on function public.is_dm(text)                          from public, anon;
grant  execute on function public.create_room(text, text, text, jsonb) to authenticated;
grant  execute on function public.claim_dm(text, text)                 to authenticated;
grant  execute on function public.player_next_turn(text, uuid, int)    to authenticated;
grant  execute on function public.is_dm(text)                          to authenticated;

-- ============ Live updates ============
do $$ begin alter publication supabase_realtime add table public.rooms;  exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.tokens; exception when duplicate_object then null; end $$;

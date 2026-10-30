-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
create table if not exists public.game_states (
  id uuid primary key default gen_random_uuid(),
  room text not null default 'table',
  layout jsonb not null,
  saved_at timestamptz not null default now()
);
create index if not exists game_states_room_saved_idx on public.game_states (room, saved_at desc);

alter table public.game_states enable row level security;

drop policy if exists "anon can read" on public.game_states;
drop policy if exists "anon can insert" on public.game_states;
create policy "anon can read"   on public.game_states for select to anon using (true);
create policy "anon can insert" on public.game_states for insert to anon with check (true);

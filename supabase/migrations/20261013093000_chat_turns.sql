-- Chat turns saved for review and training (owner, 13 Oct 2026). These are customers' words: the site may add turns, but
-- nobody can read them through the API; scripts/export-chats.ts reads them with the database login.
create table if not exists public.chat_turns (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_id text not null,
  customer text not null,
  claire text not null,
  cards text[] not null default '{}',
  chips text[] not null default '{}',
  show_contact boolean not null default false,
  provider text not null,
  enquiry jsonb not null default '[]'
);
alter table public.chat_turns enable row level security;
create policy "site adds chat turns" on public.chat_turns for insert to anon, authenticated with check (true);
grant insert on public.chat_turns to anon, authenticated;
grant all on public.chat_turns to service_role;
create index if not exists chat_turns_session on public.chat_turns(session_id, created_at);

create table if not exists public.n8n_chat_histories (
  id bigserial primary key,
  session_id varchar(255) not null,
  message jsonb not null
);

create index if not exists n8n_chat_histories_session_id_id_idx
  on public.n8n_chat_histories (session_id, id);

alter table public.n8n_chat_histories enable row level security;

revoke all on table public.n8n_chat_histories from public, anon, authenticated;
revoke all on sequence public.n8n_chat_histories_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.n8n_chat_histories to sia_huat_n8n;
grant usage, select on sequence public.n8n_chat_histories_id_seq to sia_huat_n8n;

drop policy if exists "n8n can read chat memory" on public.n8n_chat_histories;
create policy "n8n can read chat memory"
on public.n8n_chat_histories for select
to sia_huat_n8n
using (true);

drop policy if exists "n8n can create chat memory" on public.n8n_chat_histories;
create policy "n8n can create chat memory"
on public.n8n_chat_histories for insert
to sia_huat_n8n
with check (length(trim(session_id)) > 0);

drop policy if exists "n8n can update chat memory" on public.n8n_chat_histories;
create policy "n8n can update chat memory"
on public.n8n_chat_histories for update
to sia_huat_n8n
using (true)
with check (length(trim(session_id)) > 0);

drop policy if exists "n8n can clear chat memory" on public.n8n_chat_histories;
create policy "n8n can clear chat memory"
on public.n8n_chat_histories for delete
to sia_huat_n8n
using (true);

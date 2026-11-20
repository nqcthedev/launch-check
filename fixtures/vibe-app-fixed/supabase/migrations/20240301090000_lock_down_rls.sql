-- Security fixes for the initial schema (launch-check findings).
-- Applied as a new migration: the initial migration is already live and must not be edited.

-- todos: RLS was never enabled, so the anon key could read and delete every row.
-- Rows without an owner were created through the leak; remove them before adding NOT NULL.
delete from public.todos where user_id is null;
alter table public.todos alter column user_id set not null;
alter table public.todos alter column user_id set default auth.uid();
alter table public.todos enable row level security;

create policy "Users can read own todos" on public.todos
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create own todos" on public.todos
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own todos" on public.todos
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own todos" on public.todos
  for delete to authenticated using ((select auth.uid()) = user_id);

-- notes: replace the allow-everything policy with owner-only access.
drop policy "Enable all access for all users" on public.notes;
delete from public.notes where user_id is null;
alter table public.notes alter column user_id set not null;
alter table public.notes alter column user_id set default auth.uid();

create policy "Users can manage own notes" on public.notes
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- profiles: users may edit their name, but plan and credits are written only by the
-- Stripe webhook (service role). A column-level REVOKE alone would not work because
-- Supabase grants table-level UPDATE, so revoke it and grant back the safe column.
create policy "Users can update own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
revoke update on public.profiles from anon, authenticated;
grant update (full_name) on public.profiles to authenticated;

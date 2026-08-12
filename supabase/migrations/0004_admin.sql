-- ============================================================================
-- The administrator, and the one secret the server needs.
--
-- Two things that both have to live outside the browser.
--
-- Creating a login is an `auth.admin` call, which only the service key can make;
-- and the OpenAI key is a bearer credential, which anything the browser can read
-- is by definition not keeping. Both therefore go through the server functions
-- in api/, and what lives here is only the part Postgres can enforce: who counts
-- as an administrator, and a table the anon key cannot see at all.
-- ============================================================================

-- ------------------------------------------------------------------ role ---

-- `admin` joins the four business roles rather than replacing any of them. It is
-- not a bigger director: a director is a read-only audience for the figures,
-- while an admin manages accounts and has no special claim on the data.
alter type app_role add value if not exists 'admin';

/*
 * `role::text` rather than `role = 'admin'`, throughout this file.
 *
 * Postgres refuses to let a transaction use an enum value the same transaction
 * added — "unsafe use of new value" — and this migration both adds `admin` and
 * defines the functions that test for it. Comparing as text is not a workaround
 * for a lint: it is what lets the file run in one pass on a fresh database.
 */
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role::text = 'admin' from profile where id = auth.uid()), false);
$$;

/*
 * Every contract, without listing them.
 *
 * An admin's scope column is left empty on purpose. Writing {'kl','ap'} into it
 * would make the grant a copy that goes stale the moment a third contract is
 * added — and the person who adds it is the same person who would have to
 * remember. Asking the role instead cannot drift.
 */
create or replace function in_scope(want text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role::text = 'admin' or want = any (scope) from profile where id = auth.uid()),
    false);
$$;

-- ------------------------------------------------------------- profiles ----

/*
 * Until now every account could read exactly its own profile row, which is all
 * the dashboard needs. The admin screen needs the list, and needs to change
 * role and scope on it.
 *
 * Note what is *not* here: no policy lets anyone insert a profile. A profile
 * without a matching `auth.users` row is an account that cannot sign in, so the
 * two are created together by the server function or not at all.
 */
drop policy if exists profile_self on profile;
create policy profile_self on profile
  for select to authenticated using (id = auth.uid() or is_admin ());

drop policy if exists profile_admin_write on profile;
create policy profile_admin_write on profile
  for update to authenticated
  using (is_admin ())
  with check (is_admin ());

-- --------------------------------------------------------------- secrets ---

/*
 * Server-side configuration. One row per secret.
 *
 * RLS is on and there is deliberately **no policy**, which is the whole design:
 * with none, the anon and authenticated roles match no row and the table is
 * invisible to every browser, however the request is shaped. Only the service
 * key — which bypasses RLS and never leaves the Vercel function — can read it.
 *
 * A key kept here rather than in a deploy variable can be rotated with an update
 * and no redeploy, which matters because rotating it is the response to it
 * leaking.
 */
create table if not exists app_secret (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table app_secret enable row level security;

comment on table app_secret is
  'Server-only. RLS on with no policy: unreadable by anon and authenticated. '
  'Read by the service key inside api/ functions and nowhere else.';

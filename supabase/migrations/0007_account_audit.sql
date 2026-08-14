-- ============================================================================
-- Who did what to which account.
--
-- `meeting_note` has been audited since 0001, and nothing else has. Account
-- administration was the gap that mattered: an admin could create a login, reset
-- anybody's password to their employee code, change a role, or revoke access,
-- and none of it left a record anywhere. "Who reset my password on Tuesday" had
-- no answer.
--
-- Append-only by construction rather than by convention — see the policies.
-- ============================================================================

create table if not exists account_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),

  action      text not null check (
                action in ('create', 'update', 'reset', 'disable', 'enable')
              ),

  /*
   * Both sides are stored as a uuid *and* a code, which looks redundant and is
   * not. `profile` is readable only for your own row, so resolving somebody
   * else's uuid to a name needs a security-definer function — that is exactly
   * why `meeting_log` had to become one. A log that has to run a definer
   * function per row to be legible is a log nobody reads.
   *
   * The codes are also what makes the trail survive its subjects: accounts are
   * disabled rather than deleted today, but a row here must still make sense if
   * one is ever removed, so `target_id` is deliberately NOT a foreign key.
   */
  actor_id    uuid references auth.users on delete set null,
  actor_code  text not null,
  target_id   uuid,
  target_code text not null,

  /*
   * What changed, for the actions where that is a question — the before and
   * after of a role or scope change. Never a password: `reset` records that a
   * reset happened and by whom, which is the auditable fact. The value is the
   * employee code, it is already known, and writing secrets into a log is how
   * logs become the thing that leaks.
   */
  detail      jsonb
);

create index if not exists account_audit_at_idx on account_audit (at desc);
create index if not exists account_audit_target_idx on account_audit (target_id, at desc);

alter table account_audit enable row level security;

/*
 * Read: administrators, and only them. The rows name who changed whose access,
 * which is not a coordinator's business.
 */
drop policy if exists account_audit_read on account_audit;
create policy account_audit_read on account_audit
  for select to authenticated using (is_admin ());

/*
 * Write: nobody, through this API.
 *
 * There is deliberately no insert, update or delete policy. `authenticated` and
 * `anon` therefore match no row for any of those, so a browser cannot add a
 * line, edit one, or remove one however the request is shaped — the same
 * technique `app_secret` uses to stay invisible. Only the service key can write
 * here, and the only thing holding it is `api/users.js`, which writes a row for
 * every action it takes. An audit trail the audited party can edit is not one.
 */

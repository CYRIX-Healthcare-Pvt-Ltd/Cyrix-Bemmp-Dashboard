-- ============================================================================
-- Area scope: which zone, or which districts, an account works.
--
-- `scope` already answers "which contracts", and it is enforced — meeting notes
-- live in Postgres and `in_scope()` refuses the rows. This is a narrower and
-- weaker thing, and the difference is worth stating in the schema because it
-- cannot be read off the column names:
--
--   Ticket data is not in Postgres. The whole state's `tickets.bin` is
--   downloaded into the browser, so restricting somebody to South zone changes
--   what the dashboard *shows* them, not what their machine holds. It is a
--   working scope, not a confidentiality boundary. Anyone who needs the second
--   needs a separate artifact per area, which is a build change, not a column.
--
-- Empty means everything, exactly as an admin's empty `scope` grants every
-- contract. That keeps every existing account unrestricted without a backfill,
-- and it is the only default that stays correct when a district is added.
--
-- Zone and district are deliberately two columns rather than one list. They are
-- different questions — a zone is a closed set of two in Kerala and absent in
-- Andhra, a district is one of fourteen — and the client enforces "a zone, or
-- districts, never both" on top. Storing them together would make that rule
-- unexpressible and let a later edit produce a scope nobody can read aloud.
-- ============================================================================

alter table profile add column if not exists zones     text[] not null default '{}';
alter table profile add column if not exists districts text[] not null default '{}';

comment on column profile.zones is
  'Zone names this account works, empty for all. A working scope shown in the '
  'UI, not a security boundary — ticket data is served as one artifact per state.';

comment on column profile.districts is
  'District names this account works, empty for all. Ignored when zones is set.';

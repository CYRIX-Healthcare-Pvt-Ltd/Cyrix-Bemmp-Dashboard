-- ============================================================================
-- Three more designations: zonal manager, district incharge, divisional manager.
--
-- These are job titles the business already uses, not new tiers of access. What
-- makes that cheap is the shape of the existing permission model: every check in
-- the app asks whether somebody is a *director* (read-only) or an *admin*
-- (manages accounts), and everyone else works the meeting. `canEditMeeting` is
-- `role <> 'director'` and `meeting_note_write` leans on `is_director()`, so a
-- new operational role needs no policy of its own and gets working access to its
-- own contracts the moment the enum accepts it.
--
-- Adding a role is therefore adding a name. If one of these ever needs to be
-- read-only, that is a change to `is_director()` and to `canEditMeeting`, and it
-- should be made in both or the client and the database will disagree about who
-- may type in the grid.
-- ============================================================================

/*
 * `add value if not exists`, the same as 0004 did for `admin`, so a re-run is a
 * no-op rather than an error.
 *
 * Note that Postgres will not let a transaction use an enum value the same
 * transaction added — "unsafe use of new value". Nothing here compares against
 * these three, so this file is safe in one pass; anything later that tests for
 * them must either be in its own migration or compare `role::text`, which is why
 * 0004 does it that way throughout.
 */
alter type app_role add value if not exists 'zonal_manager';
alter type app_role add value if not exists 'district_incharge';
alter type app_role add value if not exists 'divisional_manager';

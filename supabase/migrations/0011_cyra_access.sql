-- ============================================================================
-- Cyra, per person (the user, 23 Sep: "make cyra enable checkbox for bemmp in
-- sw admin, defaulty make everyone as disabled").
--
-- Off for everybody, and turned on one person at a time from SW Admin's BEMMP
-- tab. An existing policy already says who may change it: profile_admin_write,
-- BEMMP administrators only. Nobody can turn it on for themselves — there is
-- no update policy for your own row.
--
-- The browser hides Cyra from anyone without it, and the assistant endpoint
-- refuses them (api/_lib/server.js reads this column with the rest of the
-- caller's profile), so the switch is not only cosmetic: OpenAI is billed per
-- question.
-- ============================================================================

alter table profile add column if not exists cyra boolean not null default false;

comment on column profile.cyra is
  'Whether this person may use Cyra, the assistant, in BEMMP. Off unless turned on in SW Admin.';

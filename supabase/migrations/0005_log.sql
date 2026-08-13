-- ============================================================================
-- The meeting's audit trail, readable.
--
-- `meeting_note_history` has recorded every field change since 0001 — column,
-- before, after, who, when — but nothing has ever shown it. The rows are there;
-- what is missing is a way to turn `changed_by` into a person.
--
-- That is the whole reason for the two functions below. `profile` is readable
-- only for your own row (and by an admin), which is right — role and contract
-- scope are nobody else's business — but it means a coordinator cannot resolve a
-- colleague's uuid to a name. A `security definer` function hands back the code
-- and nothing else, so the log reads "KLCoord" without the profile table being
-- opened up to everyone.
-- ============================================================================

/*
 * The entries for one ticket, newest first, opened on demand.
 *
 * `changed_by` can be null: the reconcile job and the original import both run
 * under the service role, which has no `auth.uid()`. Those show as the system
 * rather than as a blank, because a blank author reads like a bug.
 */
create or replace function meeting_log(p_state text, p_ticket text)
returns table (
  id bigint,
  column_name text,
  old_value text,
  new_value text,
  changed_at timestamptz,
  changed_by_code text
)
language sql stable security definer set search_path = public as $$
  select h.id, h.column_name, h.old_value, h.new_value, h.changed_at, p.code
    from meeting_note_history h
    left join profile p on p.id = h.changed_by
   where h.state = p_state
     and h.ticket = p_ticket
     and in_scope (p_state)
   order by h.changed_at desc, h.id desc
   limit 500;
$$;

revoke all on function meeting_log(text, text) from public;
grant execute on function meeting_log(text, text) to authenticated;

-- A per-ticket summary lived here briefly, to put a change count and the last
-- editor in the grid. The column became the widest thing on the row for the
-- least urgent information on it, so the cell is now one button and the trail
-- is a click away. Dropped rather than left behind unused.
drop function if exists meeting_log_summary (text, text[]);

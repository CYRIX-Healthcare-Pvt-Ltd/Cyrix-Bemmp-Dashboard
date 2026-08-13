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
 * One row per ticket: how much has been recorded, and the most recent entry.
 *
 * Asked for the whole tab at once so the grid can show a count per row without
 * a request per ticket, and kept to a summary because the tracker can carry
 * nine hundred open calls and their full history is not something to send just
 * to draw a column.
 */
create or replace function meeting_log_summary(p_state text, p_tickets text[])
returns table (ticket text, entries bigint, last_at timestamptz, last_by text)
language sql stable security definer set search_path = public as $$
  select h.ticket,
         count(*)                                      as entries,
         max(h.changed_at)                             as last_at,
         (array_agg(p.code order by h.changed_at desc))[1] as last_by
    from meeting_note_history h
    left join profile p on p.id = h.changed_by
   where h.state = p_state
     and h.ticket = any (p_tickets)
     -- The caller's own scope, checked here rather than trusted from the client:
     -- a security definer function bypasses the policy that would have done it.
     and in_scope (p_state)
   group by h.ticket;
$$;

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

revoke all on function meeting_log_summary(text, text[]) from public;
revoke all on function meeting_log(text, text) from public;
grant execute on function meeting_log_summary(text, text[]) to authenticated;
grant execute on function meeting_log(text, text) to authenticated;

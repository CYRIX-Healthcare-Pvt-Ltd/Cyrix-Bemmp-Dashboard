-- ============================================================================
-- Reconciling yesterday's meeting against today's export.
-- ============================================================================

-- The audit trigger stamped updated_at/updated_by on *every* update, including
-- the housekeeping ones below. That would have credited the whole table to
-- whoever happened to open the page first each morning. Only stamp when one of
-- the tracked columns actually moved.
create or replace function log_meeting_note_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  col     text;
  oldv    text;
  newv    text;
  touched boolean := false;
begin
  foreach col in array array[
    'penalty_type','current_status','trc_given_date','trc_spare_received_date',
    'standby_given_date','standby_days','pi_no','pi_date','pi_tat','pr_no',
    'pr_date','pr_conversion_days','pr_remark','po_no','po_date',
    'purchase_delay_days','vendor_name','payment_request_date','payment_date',
    'spare_edd','po_remark','payment_issue','not_in_scope_reason'
  ] loop
    execute format('select ($1).%I::text, ($2).%I::text', col, col)
      into oldv, newv using old, new;
    if oldv is distinct from newv then
      touched := true;
      insert into meeting_note_history (state, ticket, column_name, old_value, new_value, changed_by)
      values (new.state, new.ticket, col, oldv, newv, auth.uid());
    end if;
  end loop;

  if touched then
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end $$;

/*
 * Moves the meeting on by a day.
 *
 * Everything still open keeps its notes and has `last_seen` carried forward;
 * anything that has dropped off the open list is stamped `closed_on` rather than
 * deleted, so a call that reopens does not come back blank and the meeting keeps
 * a record of what was said about it.
 *
 * `security definer` because closing a call is housekeeping rather than an edit:
 * it has to work for a coordinator whose write policy covers only their own
 * contract, and it must not be something a director can use to change content.
 * Scope is still enforced — on the caller, explicitly, on the first line.
 */
create or replace function reconcile_open_calls(p_state text, p_tickets text[])
returns table (reopened integer, closed integer)
language plpgsql security definer set search_path = public as $$
declare
  n_reopened integer;
  n_closed   integer;
begin
  if not in_scope (p_state) then
    raise exception 'You do not have access to %', p_state using errcode = '42501';
  end if;

  update meeting_note
     set last_seen = current_date, closed_on = null
   where state = p_state
     and ticket = any (p_tickets)
     and (last_seen is distinct from current_date or closed_on is not null);
  get diagnostics n_reopened = row_count;

  update meeting_note
     set closed_on = current_date
   where state = p_state
     and closed_on is null
     and not (ticket = any (p_tickets));
  get diagnostics n_closed = row_count;

  return query select n_reopened, n_closed;
end $$;

revoke all on function reconcile_open_calls (text, text[]) from public;
grant execute on function reconcile_open_calls (text, text[]) to authenticated;

-- Creating a note row is how a first edit gets somewhere to land, so it needs an
-- insert policy — but only within scope, and not for the accounts that may not
-- edit at all.
drop policy if exists meeting_note_insert on meeting_note;
create policy meeting_note_insert on meeting_note
  for insert to authenticated
  with check (in_scope (state) and not is_director ());

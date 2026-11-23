-- =====================================================================
-- BEMMP · 0080 · Ticket tracker: the history trigger skips rows where no
-- tracked column changed
--
-- The user, 23 Nov 2026: "in ticket tracker their whole comments data lost".
-- Nothing was lost. Opening Kerala's tracker runs reconcile_open_calls, which
-- sets last_seen on ~9,100 open tickets. The history trigger ran 30 dynamic
-- EXECUTEs on every one of them (8.8 s), the call passed the 8 s limit,
-- and the tracker then showed every row without its entries. A row whose
-- tracked columns are all unchanged now returns at once; what is logged is the same.
-- =====================================================================

create or replace function public.log_meeting_note_change()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  col     text;
  oldv    text;
  newv    text;
  touched boolean := false;
  -- Columns the history does not follow: the sync dates and the row's own stamps.
  skip    text[] := array['state','ticket','legacy_values','first_seen','last_seen','closed_on','updated_by','updated_at'];
begin
  if (to_jsonb(old) - skip) = (to_jsonb(new) - skip) then
    return new;
  end if;

  foreach col in array array[
    'penalty_type','current_status','trc_given_date','trc_spare_received_date',
    'standby_given_date','standby_days','pi_no','pi_date','pi_tat','pr_no',
    'pr_date','pr_conversion_days','pr_remark','pr_status','po_no','po_date',
    'purchase_delay_days','po_status','vendor_name','payment_request_date','payment_date',
    'spare_edd','po_remark','payment_issue','not_in_scope_reason',
    'coordinator_remark','dm_remark','edc','item','dm_name'
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
end $function$;

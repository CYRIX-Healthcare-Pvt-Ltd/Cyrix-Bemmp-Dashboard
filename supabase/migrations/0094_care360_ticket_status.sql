-- =====================================================================
-- BEMMP · 0094 · Care 360 ticket tracker: Ticket Status
--
-- The Care 360 team's tracker keeps one column against each open call (the user, 27 Nov):
-- "Ticket Status - Pending/Completed" = Completed · Customer · Cyrix · Purchase · Revive Lab · Under Observation.
-- Entered in the tracker or uploaded as an Excel of PMPT ID + Ticket Status; followed in the history like
-- every other meeting field.
-- =====================================================================

alter table meeting_note add column if not exists ticket_status text;
alter table meeting_note drop constraint if exists meeting_note_ticket_status_check;
alter table meeting_note add constraint meeting_note_ticket_status_check
  check (ticket_status in ('Completed', 'Customer', 'Cyrix', 'Purchase', 'Revive Lab', 'Under Observation'));

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
    'coordinator_remark','dm_remark','edc','item','dm_name',
    'ticket_status'
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
end
$function$;

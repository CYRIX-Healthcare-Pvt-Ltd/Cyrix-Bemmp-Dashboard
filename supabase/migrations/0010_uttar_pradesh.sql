-- ============================================================================
-- Uttar Pradesh: its ticket tracker (the user, 23 Sep).
--
-- A third contract beside Kerala and Andhra, and for now only its tracker:
-- the TM export's columns, then the penalty the "UP Penalty - Auto
-- dashboard.xlsx" works out, then what the meeting enters — the Open Call
-- Tracker's columns from Q. With a log, as Kerala's has.
--
-- The meeting's fields are the ones Kerala's tracker already has where they
-- mean the same — current status, payment pending, PI, PR and PO (one PO
-- number; PR and PO status from Kerala's lists) — and five of its own:
-- coordinator and DM remark, EDC, item, DM name. They go on the same
-- meeting_note, so the same log records them.
--
-- The penalty needs each asset's per-day cost and priority: the workbook's
-- Per Day Cost sheet, 139,829 assets, which is up_asset_cost. Readable by
-- whoever may open Uttar Pradesh; written by the load, not by anyone's
-- browser.
-- ============================================================================

alter table meeting_note drop constraint if exists meeting_note_state_check;
alter table meeting_note add constraint meeting_note_state_check
  check (state in ('kl', 'ap', 'up'));

alter table dataset drop constraint if exists dataset_state_check;
alter table dataset add constraint dataset_state_check
  check (state in ('kl', 'ap', 'up'));

alter table meeting_note add column if not exists coordinator_remark text;
alter table meeting_note add column if not exists dm_remark          text;
alter table meeting_note add column if not exists edc                date;
alter table meeting_note add column if not exists item               text;
alter table meeting_note add column if not exists dm_name            text;

comment on column meeting_note.coordinator_remark is 'Uttar Pradesh: Coordinator Remark.';
comment on column meeting_note.dm_remark is 'Uttar Pradesh: DM Remark.';
comment on column meeting_note.edc is 'Uttar Pradesh: EDC, the expected date of completion.';
comment on column meeting_note.item is 'Uttar Pradesh: the item the PR and PO are for.';
comment on column meeting_note.dm_name is 'Uttar Pradesh: DM Name.';

-- The log: the same trigger, which now also watches Uttar Pradesh's five.
create or replace function log_meeting_note_change()
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
begin
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

-- ----------------------------------------------------------------------------
-- Per Day Cost: each asset's cost per day down, and its priority
-- ----------------------------------------------------------------------------
create table if not exists up_asset_cost (
  asset_no     text primary key,
  description  text,
  per_day_cost numeric not null default 0 check (per_day_cost >= 0),
  prio         text check (prio is null or prio in ('A', 'B', 'C&D')),
  billing_pct  numeric,
  asset_value  numeric,
  loaded_at    timestamptz not null default now()
);

comment on table up_asset_cost is
  'Uttar Pradesh''s Per Day Cost sheet (UP Penalty - Auto dashboard.xlsx): per asset, the '
  'cost per day down and the priority that sets the B penalty''s multiple (A 4, B 6, C&D 10).';

alter table up_asset_cost enable row level security;
drop policy if exists up_asset_cost_read on up_asset_cost;
create policy up_asset_cost_read on up_asset_cost
  for select to authenticated using (in_scope('up'));
revoke all on up_asset_cost from public, anon;
grant select on up_asset_cost to authenticated;

-- The costs of the assets a tracker is showing, in one call rather than an
-- URL of five hundred asset numbers. Under the caller's own rights, so the
-- policy above decides.
create or replace function up_asset_costs(p_assets text[])
returns table (asset_no text, per_day_cost numeric, prio text)
language sql stable
set search_path to 'public'
as $function$
  select c.asset_no, c.per_day_cost, c.prio
  from up_asset_cost c
  where c.asset_no = any (p_assets)
$function$;

revoke all on function up_asset_costs(text[]) from public, anon;
grant execute on function up_asset_costs(text[]) to authenticated;

-- ============================================================================
-- BEMMP daily penalty meeting — schema
--
-- The dashboard itself stays read-only and file-driven: ticket data is still
-- built from the TM export into public/data. What lives here is only the part
-- that cannot come from the export — what people type in the daily meeting, and
-- who is allowed to type it.
--
-- Run with:  psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_meeting.sql
-- ============================================================================

-- ------------------------------------------------------------------ roles --

-- Role decides *what you can do*, scope decides *which contract you see*, and
-- the two are independent: the AP account in the source workbook is a Director
-- who nonetheless only sees Andhra.
do $$ begin
  create type app_role as enum ('director', 'project_head', 'coordinator', 'purchase');
exception when duplicate_object then null; end $$;

create table if not exists profile (
  id         uuid primary key references auth.users on delete cascade,
  code       text unique not null,
  full_name  text,
  role       app_role not null,
  -- Which BEMMP contracts this account may open. {'kl','ap'} is the All case.
  scope      text[] not null default '{}',
  created_at timestamptz not null default now()
);

comment on column profile.scope is
  'BEMMP contract ids the account may read. Empty means no access at all.';

-- Directors are the read-only audience: they get every tab except the daily
-- penalty meeting, which is a working surface rather than a report.
create or replace function is_director() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'director' from profile where id = auth.uid()), false);
$$;

create or replace function in_scope(want text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select want = any (scope) from profile where id = auth.uid()), false);
$$;

-- ------------------------------------------------------- penalty type list --

-- The column S dropdown, as a table rather than a hard-coded list so the
-- business can extend it without a deploy.
create table if not exists penalty_type (
  name     text primary key,
  sort     integer not null default 0,
  archived boolean not null default false
);

insert into penalty_type (name, sort) values
  ('Calibration', 10), ('CAMC', 20), ('Decison Pending', 30), ('ESV', 40),
  ('Hospital Electrical Issue', 50), ('Hospital General Issue', 60),
  ('Local Service', 70), ('Massimo', 80), ('Not Under Scope', 90),
  ('OEM Service', 100), ('Others', 110), ('Part Missing', 120),
  ('PO Pending', 130), ('Rber', 140), ('Spare/Machine Waiting', 150),
  ('Specialist Attend Pending', 160), ('Standby', 170), ('TRC', 180),
  ('Waiting For Quote', 190), ('Warranty', 200)
on conflict (name) do nothing;

-- ---------------------------------------------------------- meeting notes --

-- One row per ticket per contract, holding columns S..AO of the meeting sheet.
--
-- Keyed on the ticket rather than on a surrogate id, because the join back to
-- the export is by ticket and nothing else survives a re-export.
create table if not exists meeting_note (
  state  text not null check (state in ('kl', 'ap')),
  ticket text not null,

  -- S..AO in sheet order.
  penalty_type            text references penalty_type (name),
  current_status          text,
  trc_given_date          date,
  trc_spare_received_date date,
  standby_given_date      date,
  standby_days            integer,
  pi_no                   text,
  pi_date                 date,
  pi_tat                  integer,
  pr_no                   text,
  pr_date                 date,
  pr_conversion_days      integer,
  pr_remark               text,
  po_no                   text,
  po_date                 date,
  purchase_delay_days     integer,
  vendor_name             text,
  payment_request_date    date,
  payment_date            date,
  spare_edd               date,
  po_remark               text,
  payment_issue           text,
  not_in_scope_reason     text,

  -- A date cell in the workbook is not always a date. People recorded revisions
  -- by appending to it — "7/11/2026 15-7-26 31-7-26" is one cell — so a plain
  -- `date` column would drop the very history the meeting cares about. Anything
  -- the importer could not parse is kept verbatim here, keyed by column, and
  -- shown beside the field as what the old sheet said.
  legacy_values           jsonb,

  -- Lifecycle. `closed_on` is set when a ticket stops appearing in the open
  -- list; the row is kept rather than deleted so a call that reopens does not
  -- come back blank, and so the meeting has a record of what was said.
  first_seen date not null default current_date,
  last_seen  date not null default current_date,
  closed_on  date,

  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now(),

  primary key (state, ticket)
);

create index if not exists meeting_note_open_idx
  on meeting_note (state) where closed_on is null;

-- ------------------------------------------------------------------ audit --

-- A shared grid that several people edit needs to be able to answer "who put
-- that there". Append-only; nothing in the app deletes from it.
create table if not exists meeting_note_history (
  id         bigserial primary key,
  state      text not null,
  ticket     text not null,
  column_name text not null,
  old_value  text,
  new_value  text,
  changed_by uuid references auth.users on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists meeting_note_history_ticket_idx
  on meeting_note_history (state, ticket, changed_at desc);

create or replace function log_meeting_note_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  col  text;
  oldv text;
  newv text;
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
      insert into meeting_note_history (state, ticket, column_name, old_value, new_value, changed_by)
      values (new.state, new.ticket, col, oldv, newv, auth.uid());
    end if;
  end loop;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

drop trigger if exists meeting_note_audit on meeting_note;
create trigger meeting_note_audit
  before update on meeting_note
  for each row execute function log_meeting_note_change();

-- -------------------------------------------------------------------- RLS --

alter table profile              enable row level security;
alter table penalty_type         enable row level security;
alter table meeting_note         enable row level security;
alter table meeting_note_history enable row level security;

drop policy if exists profile_self on profile;
create policy profile_self on profile
  for select to authenticated using (id = auth.uid());

drop policy if exists penalty_type_read on penalty_type;
create policy penalty_type_read on penalty_type
  for select to authenticated using (true);

-- Read what your scope covers. Directors read too — they simply have no tab
-- in the UI that shows it.
drop policy if exists meeting_note_read on meeting_note;
create policy meeting_note_read on meeting_note
  for select to authenticated using (in_scope (state));

-- Write is the actual restriction, and it lives here rather than in the UI:
-- hiding a tab is a courtesy, a policy is a control.
drop policy if exists meeting_note_write on meeting_note;
create policy meeting_note_write on meeting_note
  for update to authenticated
  using (in_scope (state) and not is_director ())
  with check (in_scope (state) and not is_director ());

drop policy if exists meeting_note_history_read on meeting_note_history;
create policy meeting_note_history_read on meeting_note_history
  for select to authenticated using (in_scope (state));

-- Rows are created and closed by the sync job under the service role, which
-- bypasses RLS. No insert or delete policy exists for end users on purpose.

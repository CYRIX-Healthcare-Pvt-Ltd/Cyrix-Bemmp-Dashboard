-- =====================================================================
-- BEMMP · 0014 · PM checklist, a project of its own
--
-- The user, 31 Oct 2026: engineers doing preventive maintenance at a
-- facility open the equipment's checklist (eleven of them, from the PDFs)
-- and submit it; coordinators see every report, a summary, and an Excel per
-- equipment; BEMMP-wise by the engineer's cost centre.
--
-- Assigned like Medtronic: 'pm' ticked in SW Admin → BEMMP. The role column
-- there decides the rest (the user: "we already have a role column"): an
-- Engineer fills; every other role sees the reports.
-- =====================================================================

alter type public.app_role add value if not exists 'engineer';

create table if not exists public.pm_reports (
  id             uuid primary key default gen_random_uuid(),
  engineer_id    uuid not null references public.employees(id),
  cost_centre    text,
  equipment      text not null,
  equipment_name text not null,
  barcode        text,
  pm_wo          text,
  facility       text not null,
  pm_date        date not null,
  start_time     time,
  end_time       time,
  handed_over    boolean,
  notes          text,
  customer_name  text,
  answers        jsonb not null default '{}'::jsonb,
  issues         int not null default 0,
  submitted_at   timestamptz not null default now()
);
create index if not exists pm_reports_date on public.pm_reports (pm_date desc);
create index if not exists pm_reports_engineer on public.pm_reports (engineer_id, pm_date desc);
create index if not exists pm_reports_equipment on public.pm_reports (equipment, pm_date desc);
alter table public.pm_reports enable row level security;

-- An Engineer with the project fills; anyone else with it sees everybody's.
create or replace function public.pm_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select in_scope('pm') and coalesce((select role::text <> 'engineer' from profile where id = auth.uid()), false);
$$;

create or replace function public.pm_sees(p_engineer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select in_scope('pm') and (p_engineer = current_employee_id() or pm_viewer());
$$;

drop policy if exists pm_reports_read on public.pm_reports;
create policy pm_reports_read on public.pm_reports for select to authenticated using (pm_sees(engineer_id));

-- What this person is in the project; null when it is not assigned to them.
create or replace function public.pm_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when current_employee_id() is null or not in_scope('pm') then null
    else jsonb_build_object('role', case when pm_viewer() then 'viewer' else 'engineer' end,
                            'cost_centre', (select function_name from employees where id = current_employee_id()))
  end;
$$;

-- The list and the summary: every report this person sees in the period, without the answers.
create or replace function public.pm_list(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'engineer_id', r.engineer_id, 'engineer_name', e.full_name, 'engineer_code', e.ecode,
      'cost_centre', r.cost_centre, 'equipment', r.equipment, 'equipment_name', r.equipment_name,
      'barcode', r.barcode, 'pm_wo', r.pm_wo, 'facility', r.facility, 'pm_date', r.pm_date,
      'start_time', r.start_time, 'end_time', r.end_time, 'handed_over', r.handed_over,
      'issues', r.issues, 'submitted_at', r.submitted_at)
    order by r.pm_date desc, r.submitted_at desc), '[]'::jsonb)
  from pm_reports r join employees e on e.id = r.engineer_id
  where pm_sees(r.engineer_id)
    and (p_from is null or r.pm_date >= p_from)
    and (p_to is null or r.pm_date <= p_to);
$$;

-- One report with its answers, or the period's reports of one equipment for the Excel.
create or replace function public.pm_reports_full(p_ids uuid[], p_equipment text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('engineer_name', e.full_name, 'engineer_code', e.ecode)
    order by r.pm_date, r.submitted_at), '[]'::jsonb)
  from pm_reports r join employees e on e.id = r.engineer_id
  where pm_sees(r.engineer_id)
    and (p_ids is null or r.id = any(p_ids))
    and (p_equipment is null or r.equipment = p_equipment)
    and (p_from is null or r.pm_date >= p_from)
    and (p_to is null or r.pm_date <= p_to);
$$;

-- Hospital names already used in this person's cost centre, most used first, so the names stay the same.
create or replace function public.pm_facilities() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(f order by n desc, f), '[]'::jsonb) from (
    select r.facility f, count(*) n
    from pm_reports r
    where in_scope('pm')
      and (r.engineer_id = current_employee_id()
           or r.cost_centre = (select function_name from employees where id = current_employee_id()))
    group by r.facility
    order by count(*) desc
    limit 500
  ) x;
$$;

create or replace function public.pm_submit(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  d date := (p->>'pm_date')::date;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  new_id uuid;
begin
  if me is null or not in_scope('pm') or pm_viewer() then
    raise exception 'Only an engineer on the PM checklist can submit one.';
  end if;
  if coalesce(p->>'equipment', '') not in ('ANU','CRS','DLM','FLP','GNE','HMA','SAA','ULS','VNT','XRDR','XRM') then
    raise exception 'Choose the equipment.';
  end if;
  if nullif(trim(p->>'equipment_name'), '') is null then raise exception 'Write the equipment name.'; end if;
  if nullif(trim(p->>'facility'), '') is null then raise exception 'Write the hospital.'; end if;
  if d is null or d > today then raise exception 'The PM date cannot be in the future.'; end if;
  if jsonb_typeof(p->'answers') is distinct from 'object' then raise exception 'The checklist is empty.'; end if;

  insert into pm_reports (engineer_id, cost_centre, equipment, equipment_name, barcode, pm_wo, facility,
                          pm_date, start_time, end_time, handed_over, notes, customer_name, answers, issues)
  values (me, (select function_name from employees where id = me), p->>'equipment',
          trim(p->>'equipment_name'), nullif(trim(p->>'barcode'), ''), nullif(trim(p->>'pm_wo'), ''),
          trim(p->>'facility'), d, nullif(p->>'start_time', '')::time, nullif(p->>'end_time', '')::time,
          (p->>'handed_over')::boolean, nullif(trim(p->>'notes'), ''), nullif(trim(p->>'customer_name'), ''),
          p->'answers',
          (select count(*) from jsonb_each(p->'answers') a where a.value->>'s' in ('Not OK', 'Abnormal', 'Unfinished')))
  returning id into new_id;
  return new_id;
end $$;

revoke all on function public.pm_viewer(), public.pm_sees(uuid), public.pm_me(), public.pm_list(date, date),
  public.pm_reports_full(uuid[], text, date, date), public.pm_facilities(), public.pm_submit(jsonb) from public, anon;
grant execute on function public.pm_viewer(), public.pm_sees(uuid), public.pm_me(), public.pm_list(date, date),
  public.pm_reports_full(uuid[], text, date, date), public.pm_facilities(), public.pm_submit(jsonb) to authenticated;

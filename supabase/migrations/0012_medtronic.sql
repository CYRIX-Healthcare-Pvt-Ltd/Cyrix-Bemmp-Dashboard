-- Medtronic — a project of its own inside BEMMP (the user, 31 Oct 2026).
--
-- The manager uploads the ticket master (TM.xlsx), assigns the work orders to his own reportees, and they close each
-- call with whether the CSAT was taken — a photo or file of it when it was. The manager's own manager sees it all.
--
-- Who is assigned the project is `profile.scope` holding 'mt', ticked in KPI → Administration → BEMMP like the
-- contracts. What they do inside it comes from the reporting line:
--   manager  — listed in mt_managers (E1266; E9999 for testing)
--   engineer — reports to a manager
--   viewer   — a manager reports to them
--
-- A new TM adds the work orders it has not seen and refreshes the rest; engineer, closure and CSAT stay. A work order
-- missing from it has left Medtronic's list, so it is closed on the last day a TM still had it ("closed date should be
-- the date of last available"). One that comes back is opened again, unless an engineer closed it.
--
-- The manager may add an "Assign to" column at the end of the TM with an engineer's E-code: those work orders go to
-- that engineer on upload; blank leaves them as they are, for assigning in BEMMP (the user, 31 Oct).

create table if not exists public.mt_managers (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  added_at    timestamptz not null default now()
);

insert into public.mt_managers (employee_id)
  select id from public.employees where ecode in ('E1266', 'E9999')
  on conflict do nothing;

create table if not exists public.mt_tickets (
  id               uuid primary key default gen_random_uuid(),
  manager_id       uuid not null references public.employees (id),
  wo               text not null,
  sap_order        text,
  sap_notification text,
  purpose          text,
  account          text,
  site             text,
  product          text,
  created_on       timestamptz,
  preferred_start  text,
  pm_planned       text,
  order_status     text,
  city             text,
  country          text,
  scheduled        text,
  technician       text,
  first_seen       date not null,
  last_seen        date not null,
  engineer_id      uuid references public.employees (id),
  assigned_at      timestamptz,
  assigned_by      uuid references public.employees (id),
  status           text not null default 'open' check (status in ('open', 'closed')),
  closed_on        date,
  closed_at        timestamptz,
  -- The engineer who closed it; null while it is open or when it was closed by leaving the TM.
  closed_by        uuid references public.employees (id),
  csat             boolean,
  proof_path       text,
  close_note       text,
  unique (manager_id, wo)
);
create index if not exists mt_tickets_engineer on public.mt_tickets (engineer_id);

create table if not exists public.mt_uploads (
  id          uuid primary key default gen_random_uuid(),
  manager_id  uuid not null references public.employees (id),
  uploaded_by uuid not null references public.employees (id),
  file_name   text,
  uploaded_at timestamptz not null default now(),
  on_day      date not null,
  rows        int not null,
  added       int not null,
  refreshed   int not null,
  reopened    int not null,
  closed      int not null,
  assigned    int not null default 0
);
create index if not exists mt_uploads_manager on public.mt_uploads (manager_id, uploaded_at desc);

alter table public.mt_managers enable row level security;
alter table public.mt_tickets enable row level security;
alter table public.mt_uploads enable row level security;

-- Seen by its manager, its engineer, the manager's manager, and a BEMMP admin; always with the project assigned.
create or replace function public.mt_sees(p_manager uuid, p_engineer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select in_scope('mt') and (
    p_manager = current_employee_id()
    or p_engineer = current_employee_id()
    or exists (select 1 from employees m where m.id = p_manager and m.reporting_manager_id = current_employee_id())
    or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
  );
$$;

drop policy if exists mt_managers_read on public.mt_managers;
create policy mt_managers_read on public.mt_managers for select to authenticated using (in_scope('mt'));
drop policy if exists mt_tickets_read on public.mt_tickets;
create policy mt_tickets_read on public.mt_tickets for select to authenticated using (mt_sees(manager_id, engineer_id));
drop policy if exists mt_uploads_read on public.mt_uploads;
create policy mt_uploads_read on public.mt_uploads for select to authenticated using (mt_sees(manager_id, null));

-- What this person is in the project; null when it is not assigned to them.
create or replace function public.mt_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when current_employee_id() is null or not in_scope('mt') then null else jsonb_build_object(
    'manager', exists (select 1 from mt_managers k where k.employee_id = current_employee_id()),
    'viewer', exists (select 1 from mt_managers k join employees e on e.id = k.employee_id
                      where e.reporting_manager_id = current_employee_id()),
    'engineer', exists (select 1 from employees e join mt_managers k on k.employee_id = e.reporting_manager_id
                        where e.id = current_employee_id()),
    'admin', coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
  ) end;
$$;

-- Everything the screens need, as one value: the work orders, the manager's team, the recent uploads.
create or replace function public.mt_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tickets', coalesce((
      select jsonb_agg(to_jsonb(t) || jsonb_build_object(
               'engineer_name', e.full_name, 'engineer_code', e.ecode,
               'manager_name', m.full_name, 'manager_code', m.ecode, 'closed_by_name', c.full_name)
             order by t.created_on desc nulls last, t.wo)
      from mt_tickets t
      join employees m on m.id = t.manager_id
      left join employees e on e.id = t.engineer_id
      left join employees c on c.id = t.closed_by
      where mt_sees(t.manager_id, t.engineer_id)), '[]'::jsonb),
    'team', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'ecode', e.ecode, 'name', e.full_name) order by e.full_name)
      from employees e
      where e.reporting_manager_id = current_employee_id() and e.is_active
        and in_scope('mt') and exists (select 1 from mt_managers k where k.employee_id = current_employee_id())), '[]'::jsonb),
    'uploads', coalesce((
      select jsonb_agg(to_jsonb(u) order by u.uploaded_at desc)
      from (select u.*, e.full_name as uploaded_by_name
            from mt_uploads u join employees e on e.id = u.uploaded_by
            where mt_sees(u.manager_id, null)
            order by u.uploaded_at desc limit 20) u), '[]'::jsonb)
  );
$$;

create or replace function public.mt_upload(p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  today date := (now() at time zone 'Asia/Kolkata')::date;
  n_rows int; n_seen int; n_reopened int; n_closed int; n_assigned int;
  unknown jsonb;
begin
  if me is null or not in_scope('mt') or not exists (select 1 from mt_managers where employee_id = me) then
    raise exception 'Only the Medtronic manager uploads the ticket master';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no work orders';
  end if;

  drop table if exists mt_in;
  create temp table mt_in on commit drop as
    select distinct on (wo) * from (
      select nullif(btrim(r->>'wo'), '') as wo,
             nullif(btrim(r->>'sap_order'), '') as sap_order,
             nullif(btrim(r->>'sap_notification'), '') as sap_notification,
             nullif(btrim(r->>'purpose'), '') as purpose,
             nullif(btrim(r->>'account'), '') as account,
             nullif(btrim(r->>'site'), '') as site,
             nullif(btrim(r->>'product'), '') as product,
             nullif(btrim(r->>'created_on'), '')::timestamptz as created_on,
             nullif(btrim(r->>'preferred_start'), '') as preferred_start,
             nullif(btrim(r->>'pm_planned'), '') as pm_planned,
             nullif(btrim(r->>'order_status'), '') as order_status,
             nullif(btrim(r->>'city'), '') as city,
             nullif(btrim(r->>'country'), '') as country,
             nullif(btrim(r->>'scheduled'), '') as scheduled,
             nullif(btrim(r->>'technician'), '') as technician,
             upper(nullif(btrim(r->>'assign_to'), '')) as assign_to
      from jsonb_array_elements(p_rows) r) x
    where wo is not null
    order by wo;

  select count(*) into n_rows from mt_in;
  if n_rows = 0 then raise exception 'The file has no work orders'; end if;
  select count(*), count(*) filter (where t.status = 'closed' and t.closed_by is null)
    into n_seen, n_reopened
    from mt_tickets t join mt_in i on i.wo = t.wo where t.manager_id = me;

  -- Still in the TM: its details refreshed; back in it after leaving, opened again.
  update mt_tickets t set
      sap_order = i.sap_order, sap_notification = i.sap_notification, purpose = i.purpose, account = i.account,
      site = i.site, product = i.product, created_on = i.created_on, preferred_start = i.preferred_start,
      pm_planned = i.pm_planned, order_status = i.order_status, city = i.city, country = i.country,
      scheduled = i.scheduled, technician = i.technician, last_seen = today,
      status    = case when t.status = 'closed' and t.closed_by is null then 'open' else t.status end,
      closed_on = case when t.status = 'closed' and t.closed_by is null then null else t.closed_on end,
      closed_at = case when t.status = 'closed' and t.closed_by is null then null else t.closed_at end
    from mt_in i
    where t.manager_id = me and t.wo = i.wo;

  insert into mt_tickets (manager_id, wo, sap_order, sap_notification, purpose, account, site, product, created_on,
                          preferred_start, pm_planned, order_status, city, country, scheduled, technician,
                          first_seen, last_seen)
    select me, i.wo, i.sap_order, i.sap_notification, i.purpose, i.account, i.site, i.product, i.created_on,
           i.preferred_start, i.pm_planned, i.order_status, i.city, i.country, i.scheduled, i.technician, today, today
    from mt_in i
    where not exists (select 1 from mt_tickets t where t.manager_id = me and t.wo = i.wo);

  -- "Assign to": to that engineer when he is in the manager's team; blank leaves it as it is.
  update mt_tickets t set engineer_id = e.id, assigned_at = now(), assigned_by = me
    from mt_in i
    join employees e on upper(e.ecode) = i.assign_to and e.reporting_manager_id = me and e.is_active
    where t.manager_id = me and t.wo = i.wo and t.closed_by is null and t.engineer_id is distinct from e.id;
  get diagnostics n_assigned = row_count;
  select coalesce(jsonb_agg(distinct i.assign_to), '[]'::jsonb) into unknown
    from mt_in i
    where i.assign_to is not null
      and not exists (select 1 from employees e
                      where upper(e.ecode) = i.assign_to and e.reporting_manager_id = me and e.is_active);

  -- Left the TM: closed, on the last day a TM still had it.
  update mt_tickets t set status = 'closed', closed_on = t.last_seen, closed_at = now()
    where t.manager_id = me and t.status = 'open'
      and not exists (select 1 from mt_in i where i.wo = t.wo);
  get diagnostics n_closed = row_count;

  insert into mt_uploads (manager_id, uploaded_by, file_name, on_day, rows, added, refreshed, reopened, closed, assigned)
    values (me, me, left(p_file, 200), today, n_rows, n_rows - n_seen, n_seen, n_reopened, n_closed, n_assigned);

  return jsonb_build_object('rows', n_rows, 'added', n_rows - n_seen, 'refreshed', n_seen,
                            'reopened', n_reopened, 'closed', n_closed, 'assigned', n_assigned, 'unknown', unknown);
end $$;

-- One or many at once, to one of the manager's own reportees; null takes the engineer off.
create or replace function public.mt_assign(p_ids uuid[], p_engineer uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  n int;
begin
  if me is null or not in_scope('mt') or not exists (select 1 from mt_managers where employee_id = me) then
    raise exception 'Only the Medtronic manager assigns work orders';
  end if;
  if p_engineer is not null and not exists (
       select 1 from employees where id = p_engineer and reporting_manager_id = me and is_active) then
    raise exception 'Choose one of your team';
  end if;
  update mt_tickets set engineer_id = p_engineer,
                        assigned_at = case when p_engineer is null then null else now() end,
                        assigned_by = me
    where id = any (p_ids) and manager_id = me and closed_by is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- The engineer closes the call: CSAT taken or not, its proof when it was. A work order already closed by leaving the
-- TM keeps that date and takes the CSAT.
create or replace function public.mt_close(p_id uuid, p_csat boolean, p_proof text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  t mt_tickets;
begin
  select * into t from mt_tickets where id = p_id for update;
  if not found or me is null or t.engineer_id is distinct from me or not in_scope('mt') then
    raise exception 'Only the engineer it is assigned to closes it';
  end if;
  if t.closed_by is not null then raise exception 'This call is already closed'; end if;
  if p_csat is null then raise exception 'Choose whether the CSAT was taken'; end if;
  if p_csat and (p_proof is null or split_part(p_proof, '/', 1) <> p_id::text
                 or not exists (select 1 from storage.objects where bucket_id = 'mt-proof' and name = p_proof)) then
    raise exception 'Add the CSAT proof';
  end if;
  update mt_tickets set
      status = 'closed',
      closed_on = case when status = 'closed' then closed_on else (now() at time zone 'Asia/Kolkata')::date end,
      closed_at = now(), closed_by = me, csat = p_csat,
      proof_path = case when p_csat then p_proof end,
      close_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_id;
end $$;

-- CSAT proof: a private bucket, one folder per work order. Added by its engineer before closing; seen by whoever sees it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mt-proof', 'mt-proof', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do nothing;

create or replace function public.mt_proof_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  tid uuid;
  t mt_tickets;
begin
  begin
    tid := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  select * into t from mt_tickets where id = tid;
  if not found then return false; end if;
  if p_write then return in_scope('mt') and t.engineer_id = current_employee_id() and t.closed_by is null; end if;
  return mt_sees(t.manager_id, t.engineer_id);
end $$;

drop policy if exists mt_proof_insert on storage.objects;
create policy mt_proof_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'mt-proof' and public.mt_proof_ok(name, true));
drop policy if exists mt_proof_read on storage.objects;
create policy mt_proof_read on storage.objects for select to authenticated
  using (bucket_id = 'mt-proof' and public.mt_proof_ok(name, false));

-- Signed-in callers only (0223).
revoke all on function public.mt_sees(uuid, uuid), public.mt_me(), public.mt_data(), public.mt_upload(jsonb, text),
  public.mt_assign(uuid[], uuid), public.mt_close(uuid, boolean, text, text), public.mt_proof_ok(text, boolean)
  from public, anon;
grant execute on function public.mt_sees(uuid, uuid), public.mt_me(), public.mt_data(), public.mt_upload(jsonb, text),
  public.mt_assign(uuid[], uuid), public.mt_close(uuid, boolean, text, text), public.mt_proof_ok(text, boolean)
  to authenticated;

-- Run again after "Assign to" was added the same day: the column the table was first made without.
alter table public.mt_uploads add column if not exists assigned int not null default 0;

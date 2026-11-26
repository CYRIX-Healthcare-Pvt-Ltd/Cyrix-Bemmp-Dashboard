-- =====================================================================
-- BEMMP · 0077 · Medtronic: the engineer accepts, starts, updates and completes
--
-- The user, 23 Nov 2026: "engineer need to accept the ticket, so tabs are to
-- accept, to start, pending, completed". Accept → Start (status Started) →
-- Pending with a status (Started, Observation, Waiting for spare, Waiting for
-- customer, Under repair) → Completed with any service report files
-- (optional). The CSAT is not asked any more (the user, 23 Nov: "csat field
-- not needed now"); earlier answers stay on their tickets. The times give accept, start and job TAT, used to score
-- the engineers' KPI; time waiting for spare counts in the job TAT and is
-- also kept on its own.
--
-- Medtronic's own state is separate (the user: "a tag ie closed in medtronics
-- software"): a ticket missing from a newer TM gets mt_closed_on and keeps its
-- engineer stage. Only a ticket nobody was given still closes as before.
-- status/closed_* now mean the call is closed on our side.
-- =====================================================================

alter table public.mt_tickets
  add column if not exists accepted_at    timestamptz,
  add column if not exists started_at     timestamptz,
  add column if not exists work_status    text,
  add column if not exists work_status_at timestamptz,
  add column if not exists spare_secs     integer not null default 0,
  add column if not exists mt_closed_on   date,
  add column if not exists report_paths   text[] not null default '{}';

alter table public.mt_tickets drop constraint if exists mt_tickets_work_status_check;
alter table public.mt_tickets add constraint mt_tickets_work_status_check
  check (work_status is null or work_status in ('started', 'observation', 'waiting_spare', 'waiting_customer', 'under_repair'));

-- Every step, for checking a score later.
create table if not exists public.mt_events (
  id         bigint generated always as identity primary key,
  ticket_id  uuid not null references public.mt_tickets(id) on delete cascade,
  at         timestamptz not null default now(),
  by         uuid references public.employees(id),
  kind       text not null,          -- assigned, accepted, started, status, completed, mt_closed, mt_open
  detail     text
);
create index if not exists mt_events_ticket on public.mt_events (ticket_id, at);
alter table public.mt_events enable row level security;
drop policy if exists mt_events_read on public.mt_events;
create policy mt_events_read on public.mt_events for select to authenticated
  using (exists (select 1 from public.mt_tickets t where t.id = ticket_id and public.mt_sees(t.manager_id, t.engineer_id)));

-- What a TM upload closed so far becomes the Medtronic tag. The three that
-- had an engineer go back to the engineer; the ones nobody had stay closed.
update public.mt_tickets set mt_closed_on = closed_on
  where status = 'closed' and closed_by is null and mt_closed_on is null;
update public.mt_tickets set status = 'open', closed_on = null, closed_at = null
  where status = 'closed' and closed_by is null and engineer_id is not null;

-- ---------------------------------------------------------------- upload --
do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.mt_upload(jsonb, text)'::regprocedure);
  g := f;
  -- Back in the TM: the tag goes; a ticket closed only by the TM opens again.
  g := replace(g, 'scheduled = i.scheduled, technician = i.technician, last_seen = today,',
                  'scheduled = i.scheduled, technician = i.technician, last_seen = today, mt_closed_on = null,');
  -- Reassigning on upload starts the new engineer from To accept.
  g := replace(g, 'update mt_tickets t set engineer_id = e.id, assigned_at = now(), assigned_by = me',
                  'update mt_tickets t set engineer_id = e.id, assigned_at = now(), assigned_by = me,
                          accepted_at = null, started_at = null, work_status = null, work_status_at = null, spare_secs = 0,
                          status = ''open'', closed_on = null, closed_at = null');
  -- Left the TM: tagged; closed on our side only when nobody was given it.
  g := replace(g, 'update mt_tickets t set status = ''closed'', closed_on = today - 1, closed_at = now()
    where t.manager_id = me and t.status = ''open''
      and not exists (select 1 from mt_in i where i.wo = t.wo);',
                  'update mt_tickets t set mt_closed_on = today - 1,
         status    = case when t.engineer_id is null and t.closed_by is null then ''closed'' else t.status end,
         closed_on = case when t.engineer_id is null and t.closed_by is null then today - 1 else t.closed_on end,
         closed_at = case when t.engineer_id is null and t.closed_by is null then now() else t.closed_at end
    where t.manager_id = me and t.mt_closed_on is null
      and not exists (select 1 from mt_in i where i.wo = t.wo);');
  if g = f or position('mt_closed_on = today - 1' in g) = 0 or position('accepted_at = null' in g) = 0
     or position('mt_closed_on = null' in g) = 0 then
    raise exception 'mt_upload is not as expected; nothing changed';
  end if;
  execute g;
end $$;

-- ---------------------------------------------------------------- assign --
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
  -- A new engineer starts from To accept; the same one keeps where they are.
  with u as (
    update mt_tickets set engineer_id = p_engineer,
                          assigned_at = case when p_engineer is null then null else now() end,
                          assigned_by = me,
                          accepted_at = null, started_at = null, work_status = null, work_status_at = null, spare_secs = 0,
                          status = case when p_engineer is null then status else 'open' end,
                          closed_on = case when p_engineer is null then closed_on else null end,
                          closed_at = case when p_engineer is null then closed_at else null end
      where id = any (p_ids) and manager_id = me and closed_by is null and engineer_id is distinct from p_engineer
      returning id)
  insert into mt_events (ticket_id, by, kind, detail)
    select u.id, me, 'assigned', (select ecode from employees where id = p_engineer) from u;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------- engineer's steps --
create or replace function public.mt_accept(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); n int;
begin
  if me is null or not in_scope('mt') then raise exception 'Only the engineer it is assigned to accepts it'; end if;
  with u as (
    update mt_tickets set accepted_at = now()
      where id = any (p_ids) and engineer_id = me and accepted_at is null and closed_by is null
      returning id)
  insert into mt_events (ticket_id, by, kind) select id, me, 'accepted' from u;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to accept: it may be accepted already or given to someone else'; end if;
  return n;
end $$;

create or replace function public.mt_start(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); t mt_tickets;
begin
  select * into t from mt_tickets where id = p_id for update;
  if not found or me is null or t.engineer_id is distinct from me or not in_scope('mt') then
    raise exception 'Only the engineer it is assigned to starts it';
  end if;
  if t.closed_by is not null then raise exception 'This call is already completed'; end if;
  if t.accepted_at is null then raise exception 'Accept it first'; end if;
  if t.started_at is not null then raise exception 'It is started already'; end if;
  update mt_tickets set started_at = now(), work_status = 'started', work_status_at = now() where id = p_id;
  insert into mt_events (ticket_id, by, kind, detail) values (p_id, me, 'started', 'started');
end $$;

create or replace function public.mt_set_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); t mt_tickets;
begin
  select * into t from mt_tickets where id = p_id for update;
  if not found or me is null or t.engineer_id is distinct from me or not in_scope('mt') then
    raise exception 'Only the engineer it is assigned to updates it';
  end if;
  if t.closed_by is not null then raise exception 'This call is already completed'; end if;
  if t.started_at is null then raise exception 'Start it first'; end if;
  if p_status not in ('started', 'observation', 'waiting_spare', 'waiting_customer', 'under_repair') then
    raise exception 'Choose a status';
  end if;
  if p_status = t.work_status then return; end if;
  update mt_tickets set
      spare_secs = spare_secs + case when t.work_status = 'waiting_spare'
                                     then greatest(0, extract(epoch from now() - t.work_status_at))::int else 0 end,
      work_status = p_status, work_status_at = now()
    where id = p_id;
  insert into mt_events (ticket_id, by, kind, detail) values (p_id, me, 'status', p_status);
end $$;

-- -------------------------------------------------------------- complete --
drop function if exists public.mt_close(uuid, boolean, text, text);
create or replace function public.mt_close(p_id uuid, p_csat boolean default null, p_proof text default null, p_note text default null,
                                           p_reports text[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  t mt_tickets;
  reps text[] := coalesce(p_reports, '{}');
begin
  select * into t from mt_tickets where id = p_id for update;
  if not found or me is null or t.engineer_id is distinct from me or not in_scope('mt') then
    raise exception 'Only the engineer it is assigned to completes it';
  end if;
  if t.closed_by is not null then raise exception 'This call is already completed'; end if;
  if t.started_at is null then raise exception 'Start it first'; end if;
  if coalesce(p_csat, false) and (p_proof is null or split_part(p_proof, '/', 1) <> p_id::text
                 or not exists (select 1 from storage.objects where bucket_id = 'mt-proof' and name = p_proof)) then
    raise exception 'Add the CSAT proof';
  end if;
  if exists (select 1 from unnest(reps) r
             where split_part(r, '/', 1) <> p_id::text
                or not exists (select 1 from storage.objects o where o.bucket_id = 'mt-proof' and o.name = r)) then
    raise exception 'A service report file did not upload. Add it again';
  end if;
  update mt_tickets set
      spare_secs = spare_secs + case when work_status = 'waiting_spare'
                                     then greatest(0, extract(epoch from now() - work_status_at))::int else 0 end,
      work_status_at = now(),
      status = 'closed',
      closed_on = (now() at time zone 'Asia/Kolkata')::date,
      closed_at = now(), closed_by = me, csat = p_csat,
      proof_path = case when coalesce(p_csat, false) then p_proof end,
      report_paths = reps,
      close_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_id;
  insert into mt_events (ticket_id, by, kind, detail) values (p_id, me, 'completed', array_length(reps, 1)::text || ' report file(s)');
end $$;

revoke all on function public.mt_accept(uuid[]) from public, anon;
revoke all on function public.mt_start(uuid) from public, anon;
revoke all on function public.mt_set_status(uuid, text) from public, anon;
revoke all on function public.mt_close(uuid, boolean, text, text, text[]) from public, anon;
grant execute on function public.mt_accept(uuid[]) to authenticated;
grant execute on function public.mt_start(uuid) to authenticated;
grant execute on function public.mt_set_status(uuid, text) to authenticated;
grant execute on function public.mt_close(uuid, boolean, text, text, text[]) to authenticated;

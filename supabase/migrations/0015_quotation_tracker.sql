-- =====================================================================
-- BEMMP · 0015 · Quotation tracker, a project of its own
--
-- The user, 11 Nov 2026: the spare-quotation tracker kept in a Google
-- Sheet with an Apps Script moves into our database as a BEMMP project,
-- every screen in our own design. The workflow is the script's:
--
--   Engineer raises a spare  → Team Lead approves (CAMC skips pricing)
--   → Coordinator: SAP rate / ask Purchase / close / ask the Team Lead
--   → Purchase rates (original + compatible) → PV picks one
--   → Coordinator: quotation only / PR / hold / cancel
--   → Purchase PO and dispatch (tracking) → Engineer receipt
--     (faulty → Purchase: cancel / to stock / return → replacement)
--   STK: a Coordinator's stock request goes straight to Purchase dispatch.
--
-- Every step waits for an Accept, so who accepted late shows (the user:
-- "ya neEd accept"). Each Accept and each action is an event; TAT is read
-- from the events against each stage's targets in qt_stage_targets.
-- People and their roles are the project's own (qt_people): the Team Lead
-- of an engineer is the one named there, as the sheet's Reporting column,
-- not the KPI reporting line, which differs for several engineers.
-- Mails are built in the app's outbox but stay off (the user: "email now
-- disable, but we need to enable after testing").
-- =====================================================================

-- ------------------------------------------------------------ people --
create table if not exists public.qt_people (
  employee_id  uuid primary key references public.employees(id) on delete cascade,
  role         text not null check (role in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv')),
  is_lead      boolean not null default false,   -- Coordinator - Lead, Purchase - Head: everything, settings, people
  team_lead_id uuid references public.employees(id) on delete set null,
  added_by     uuid references public.employees(id) on delete set null,
  added_at     timestamptz not null default now()
);
alter table public.qt_people enable row level security;

create or replace function public.qt_role() returns text
language sql stable security definer set search_path = public as $$
  select role from qt_people where employee_id = current_employee_id()
$$;

create or replace function public.qt_is_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_lead from qt_people where employee_id = current_employee_id()), false)
    or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
$$;

-- ------------------------------------------------------- facilities --
create table if not exists public.qt_facilities (
  id          uuid primary key default gen_random_uuid(),
  state       text not null,
  district    text not null default '',
  name        text not null,
  category    text not null default 'AMC' check (category in ('AMC', 'CAMC', 'CAMC & AMC')),
  created_by  uuid references public.employees(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.employees(id) on delete set null,
  updated_at  timestamptz
);
create unique index if not exists qt_facilities_name on public.qt_facilities (lower(state), lower(district), lower(name));
alter table public.qt_facilities enable row level security;

create table if not exists public.qt_facility_log (
  id          bigint generated always as identity primary key,
  facility_id uuid references public.qt_facilities(id) on delete set null,
  at          timestamptz not null default now(),
  by          uuid references public.employees(id) on delete set null,
  action      text not null,
  before      jsonb,
  after       jsonb
);
alter table public.qt_facility_log enable row level security;

-- --------------------------------------------------------- requests --
create table if not exists public.qt_requests (
  id              uuid primary key default gen_random_uuid(),
  no              text not null unique,                       -- REQ-158, STK-2
  kind            text not null default 'request' check (kind in ('request', 'stock')),
  step            text not null,
  step_since      timestamptz not null default now(),
  accepted_by     uuid references public.employees(id),
  accepted_at     timestamptz,
  done            boolean not null default false,
  hold_from       text,                                       -- the step a hold returns to
  engineer_id     uuid references public.employees(id),       -- requester, or the stock's stakeholder
  team_lead_id    uuid references public.employees(id),
  raised_by       uuid references public.employees(id),
  coord_id        uuid references public.employees(id),
  purchase_id     uuid references public.employees(id),
  pv_id           uuid references public.employees(id),
  tl_by           uuid references public.employees(id),
  created_at      timestamptz not null default now(),
  client_token    text,
  -- where and what
  facility_id     uuid references public.qt_facilities(id) on delete set null,
  state           text, district text, hospital text, category text,
  equipment       text, make text, model text, serial text, equipment_photo text,
  spare           text not null, part_no text, qty int not null check (qty > 0), photos text[] not null default '{}',
  engineer_note   text,
  delivery_address text,
  -- prices
  sap             boolean not null default false,
  orig_vendor text, orig_rate numeric, orig_tax numeric, orig_photo text,
  comp_vendor text, comp_rate numeric, comp_tax numeric, comp_photo text,
  warranty text, lead_days int, purchase_note text, picked text check (picked in ('original', 'compatible')),
  -- PR
  quote_submitted date, quote_approved date, pr_no text, pr_date date, item_code text, approved_qty int, coord_note text,
  -- PO and dispatch
  po_no text, po_date date, vendor text, track_mode text, track_no text, dispatch_note text, dispatched_at timestamptz,
  -- receipt
  received_on date, received_qty int not null default 0, used_qty int not null default 0, faulty_qty int not null default 0,
  faulty_kind text, faulty_note text, faulty_action text, return_address text, return_track_mode text, return_track_no text,
  closed_at       timestamptz,
  close_note      text
);
create index if not exists qt_requests_step on public.qt_requests (step) where not done;
create index if not exists qt_requests_engineer on public.qt_requests (engineer_id);
create index if not exists qt_requests_tl on public.qt_requests (team_lead_id);
create unique index if not exists qt_requests_token on public.qt_requests (client_token, spare) where client_token is not null;
alter table public.qt_requests enable row level security;

create table if not exists public.qt_events (
  id          bigint generated always as identity primary key,
  request_id  uuid not null references public.qt_requests(id) on delete cascade,
  at          timestamptz not null default now(),
  by          uuid references public.employees(id),
  step        text not null,          -- the step it happened at
  action      text not null,          -- accept, approve, close, ask, reply, rates, ...
  to_step     text,
  note        text,
  accept_s    int,                    -- waiting before the Accept
  process_s   int                     -- from the Accept to this action
);
create index if not exists qt_events_request on public.qt_events (request_id, at);
create index if not exists qt_events_at on public.qt_events (at);
alter table public.qt_events enable row level security;

-- How long each stage may take to accept and to process, in hours (the user: amber, then red).
create table if not exists public.qt_stage_targets (
  step       text primary key,
  accept_h   numeric not null default 4,
  process_h  numeric not null default 24
);
alter table public.qt_stage_targets enable row level security;
insert into public.qt_stage_targets (step, accept_h, process_h) values
  ('tl_review', 4, 24), ('tl_clarify', 4, 24), ('coord_initial', 4, 24), ('purchase_rates', 4, 48),
  ('pv', 4, 24), ('coord_pr', 4, 24), ('coord_decide', 4, 24), ('purchase_dispatch', 4, 72),
  ('receipt', 24, 72), ('purchase_faulty', 4, 24), ('return_dispatch', 24, 72), ('purchase_replacement', 4, 72)
on conflict (step) do nothing;

-- Mails per stage are queued here and stay unsent while qt_mail_on is off (the user, 11 Nov).
create table if not exists public.qt_outbox (
  id          bigint generated always as identity primary key,
  request_id  uuid references public.qt_requests(id) on delete cascade,
  to_employee uuid references public.employees(id),
  stage       text not null,
  subject     text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
alter table public.qt_outbox enable row level security;
insert into public.app_settings (key, value) values ('qt_mail_on', '{"on": false}'::jsonb) on conflict (key) do nothing;

-- ------------------------------------------------------------ rules --

/* Who works a step: its person, or anyone of that role until someone accepts. Leads work any of their role. */
create or replace function public.qt_role_of_step(p_step text, p_kind text) returns text
language sql immutable as $$
  select case
    when p_step in ('tl_review', 'tl_clarify') then 'team_lead'
    when p_step in ('coord_initial', 'coord_pr', 'coord_decide', 'on_hold', 'on_hold_dispatch') then 'coordinator'
    when p_step in ('purchase_rates', 'purchase_dispatch', 'purchase_faulty', 'purchase_replacement') then 'purchase'
    when p_step = 'pv' then 'pv'
    when p_step in ('receipt', 'observation') then 'engineer'
    when p_step = 'return_dispatch' then case when p_kind = 'stock' then 'coordinator' else 'engineer' end
  end
$$;

create or replace function public.qt_can_act(r public.qt_requests) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare me uuid := current_employee_id(); p qt_people; want text;
begin
  if me is null or r.done then return false; end if;
  select * into p from qt_people where employee_id = me;
  if not found then return false; end if;
  want := qt_role_of_step(r.step, r.kind);
  if want = 'team_lead' then return r.team_lead_id = me or (p.role = 'team_lead' and p.is_lead); end if;
  if want = 'engineer' then
    return r.engineer_id = me;
  end if;
  if p.role <> want then return false; end if;
  if p.is_lead then return true; end if;
  if want = 'coordinator' then return r.coord_id is null or r.coord_id = me; end if;
  if want = 'purchase' then return r.purchase_id is null or r.purchase_id = me; end if;
  return true;
end $$;

create or replace function public.qt_sees(r public.qt_requests) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare me uuid := current_employee_id(); p qt_people;
begin
  if me is null then return false; end if;
  if coalesce((select role::text = 'admin' from profile where id = auth.uid()), false) then return true; end if;
  select * into p from qt_people where employee_id = me;
  if not found then return false; end if;
  if p.role in ('coordinator', 'purchase', 'pv') or p.is_lead then return true; end if;
  return r.engineer_id = me or r.raised_by = me or r.team_lead_id = me;
end $$;

create or replace function public.qt_secs(a timestamptz, b timestamptz) returns int
language sql immutable as $$ select greatest(0, floor(extract(epoch from (b - a))))::int $$;

/* A bell and phone message to one person (BEMMP's own bell, 'bemmp' in message_app). */
create or replace function public.qt_tell(p_to uuid, p_title text, p_body text, p_req uuid)
returns void language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if p_to is null or p_to = current_employee_id() then return; end if;
  insert into push_messages (kind, title, body, url, target, sent_by)
  values ('bemmp', left(p_title, 80), left(coalesce(p_body, ''), 400), '/bemmp/?q=' || p_req,
          jsonb_build_object('kind', 'bemmp', 'quotation', p_req), current_employee_id())
  returning id into mid;
  insert into push_inbox (message_id, employee_id) values (mid, p_to);
end $$;

/* Everybody of a role, for a step nobody has accepted yet. */
create or replace function public.qt_tell_role(p_role text, p_title text, p_body text, p_req uuid)
returns void language plpgsql security definer set search_path = public as $$
declare x uuid;
begin
  for x in select employee_id from qt_people where role = p_role loop
    perform qt_tell(x, p_title, p_body, p_req);
  end loop;
end $$;

/* Tells whoever works the request's step now: its person, or the role's pool. */
create or replace function public.qt_tell_next(r public.qt_requests, p_title text)
returns void language plpgsql security definer set search_path = public as $$
declare body text := r.no || ' · ' || r.spare || ' × ' || r.qty || coalesce(' · ' || r.hospital, '');
  want text := qt_role_of_step(r.step, r.kind);
begin
  if r.done then
    perform qt_tell(r.engineer_id, p_title, body, r.id);
  elsif want = 'team_lead' then perform qt_tell(r.team_lead_id, p_title, body, r.id);
  elsif want = 'engineer' then perform qt_tell(r.engineer_id, p_title, body, r.id);
  elsif want = 'coordinator' and r.coord_id is not null then perform qt_tell(r.coord_id, p_title, body, r.id);
  elsif want = 'purchase' and r.purchase_id is not null then perform qt_tell(r.purchase_id, p_title, body, r.id);
  else perform qt_tell_role(want, p_title, body, r.id);
  end if;
  insert into qt_outbox (request_id, to_employee, stage, subject)
  values (r.id, case want when 'team_lead' then r.team_lead_id when 'engineer' then r.engineer_id
                        when 'coordinator' then r.coord_id when 'purchase' then r.purchase_id end,
          r.step, '[' || r.no || '] ' || p_title || ' | ' || r.spare || ' | ' || coalesce(nullif(r.hospital, ''), 'Stock'));
end $$;

/* Moves a request on: the event with its TAT, the new step, and who hears of it. */
create or replace function public.qt_move(p_id uuid, p_action text, p_to text, p_note text, p_done boolean default false)
returns public.qt_requests language plpgsql security definer set search_path = public as $$
declare r qt_requests; me uuid := current_employee_id();
begin
  select * into r from qt_requests where id = p_id for update;
  insert into qt_events (request_id, by, step, action, to_step, note, process_s)
  values (r.id, me, r.step, p_action, p_to, nullif(btrim(coalesce(p_note, '')), ''),
          case when r.accepted_at is not null then qt_secs(r.accepted_at, now()) end);
  update qt_requests set step = p_to, step_since = now(), accepted_by = null, accepted_at = null,
    done = p_done, closed_at = case when p_done then now() end
  where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.qt_get(p_id uuid) returns public.qt_requests
language plpgsql stable security definer set search_path = public as $$
declare r qt_requests;
begin
  select * into r from qt_requests where id = p_id;
  if not found or not qt_can_act(r) then raise exception 'This request is not with you now. Pull down to refresh.'; end if;
  return r;
end $$;

create or replace function public.qt_need(p_text text, p_what text) returns text
language plpgsql immutable as $$
begin
  if nullif(btrim(coalesce(p_text, '')), '') is null then raise exception 'Write the %.', p_what; end if;
  return btrim(p_text);
end $$;

/* Steps that wait for an Accept; a hold or an observation does not. */
create or replace function public.qt_needs_accept(p_step text) returns boolean
language sql immutable as $$ select p_step not in ('on_hold', 'on_hold_dispatch', 'observation') $$;

create or replace function public.qt_check_accepted(r public.qt_requests) returns void
language plpgsql stable as $$
begin
  if qt_needs_accept(r.step) and r.accepted_at is null then raise exception 'Accept % first.', r.no; end if;
end $$;

-- ------------------------------------------------------------- me --
create or replace function public.qt_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when current_employee_id() is null then null
    when exists (select 1 from qt_people where employee_id = current_employee_id())
      then (select jsonb_build_object('role', p.role, 'lead', p.is_lead or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
              'team_lead_id', p.team_lead_id, 'team_lead_name', (select full_name from employees where id = p.team_lead_id))
            from qt_people p where p.employee_id = current_employee_id())
    when coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
      then jsonb_build_object('role', 'viewer', 'lead', true)
  end
$$;

-- ------------------------------------------------------------ reading --

/* Every request this person sees: open ones always, finished ones in the period (by when they were raised). */
create or replace function public.qt_list(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg((to_jsonb(r) - 'client_token') || jsonb_build_object(
      'accepted_by_name', a.full_name, 'engineer_name', e.full_name, 'engineer_code', e.ecode,
      'team_lead_name', t.full_name, 'coord_name', c.full_name, 'purchase_name', pu.full_name, 'pv_name', pv.full_name,
      'mine', qt_can_act(r)) order by r.created_at desc), '[]'::jsonb)
  from qt_requests r
  left join employees e on e.id = r.engineer_id
  left join employees t on t.id = r.team_lead_id
  left join employees c on c.id = r.coord_id
  left join employees pu on pu.id = r.purchase_id
  left join employees pv on pv.id = r.pv_id
  left join employees a on a.id = r.accepted_by
  where qt_sees(r)
    and (not r.done
         or ((p_from is null or (r.created_at at time zone 'Asia/Kolkata')::date >= p_from)
             and (p_to is null or (r.created_at at time zone 'Asia/Kolkata')::date <= p_to)))
$$;

/* One request, with its timeline. */
create or replace function public.qt_one(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r qt_requests;
begin
  select * into r from qt_requests where id = p_id;
  if not found or not qt_sees(r) then return null; end if;
  return to_jsonb(r) || jsonb_build_object(
    'mine', qt_can_act(r),
    'engineer_name', (select full_name from employees where id = r.engineer_id),
    'engineer_code', (select ecode from employees where id = r.engineer_id),
    'team_lead_name', (select full_name from employees where id = r.team_lead_id),
    'raised_by_name', (select full_name from employees where id = r.raised_by),
    'coord_name', (select full_name from employees where id = r.coord_id),
    'purchase_name', (select full_name from employees where id = r.purchase_id),
    'pv_name', (select full_name from employees where id = r.pv_id),
    'accepted_by_name', (select full_name from employees where id = r.accepted_by),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', v.at, 'step', v.step, 'action', v.action, 'to_step', v.to_step,
                 'note', v.note, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by_name', b.full_name, 'by_code', b.ecode) order by v.at, v.id)
               from qt_events v left join employees b on b.id = v.by where v.request_id = r.id), '[]'::jsonb));
end $$;

create or replace function public.qt_facility_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'state', f.state, 'district', f.district, 'name', f.name, 'category', f.category,
           'created_by', c.full_name, 'created_at', f.created_at, 'updated_by', u.full_name, 'updated_at', f.updated_at)
           order by f.state, f.district, f.name), '[]'::jsonb)
  from qt_facilities f left join employees c on c.id = f.created_by left join employees u on u.id = f.updated_by
  where qt_me() is not null
$$;

/* What an engineer raised before at a hospital, so the next raise fills itself (idea 7). */
create or replace function public.qt_equipment_at(p_facility uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'last' desc), '[]'::jsonb) from (
    select jsonb_build_object('equipment', r.equipment, 'make', r.make, 'model', r.model, 'serial', r.serial, 'last', max(r.created_at)) x
    from qt_requests r
    where r.facility_id = p_facility and r.kind = 'request' and r.equipment is not null and qt_me() is not null
    group by r.equipment, r.make, r.model, r.serial
    order by max(r.created_at) desc limit 30
  ) s
$$;

create or replace function public.qt_people_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', p.employee_id, 'name', e.full_name, 'ecode', e.ecode, 'role', p.role,
           'lead', p.is_lead, 'team_lead_id', p.team_lead_id, 'team_lead_name', t.full_name, 'active', e.is_active,
           'designation', e.designation)
           order by p.role, e.full_name), '[]'::jsonb)
  from qt_people p join employees e on e.id = p.employee_id left join employees t on t.id = p.team_lead_id
  where qt_me() is not null
$$;

create or replace function public.qt_targets() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(step, jsonb_build_object('accept_h', accept_h, 'process_h', process_h)), '{}'::jsonb)
  from qt_stage_targets where qt_me() is not null
$$;

/* Every event of the period for the TAT dashboard and the Excel (idea 12, 13). */
create or replace function public.qt_events_in(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('request_id', v.request_id, 'no', r.no, 'at', v.at, 'step', v.step, 'action', v.action,
           'accept_s', v.accept_s, 'process_s', v.process_s, 'by', v.by, 'by_name', b.full_name, 'by_code', b.ecode) order by v.at), '[]'::jsonb)
  from qt_events v join qt_requests r on r.id = v.request_id left join employees b on b.id = v.by
  where qt_sees(r)
    and (p_from is null or (v.at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (v.at at time zone 'Asia/Kolkata')::date <= p_to)
$$;

-- ------------------------------------------------------------ raising --

create or replace function public.qt_next_no(p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare pre text := case p_kind when 'stock' then 'STK' else 'REQ' end; n int;
begin
  perform pg_advisory_xact_lock(hashtext('qt_no_' || pre));
  select coalesce(max(nullif(regexp_replace(no, '^' || pre || '-', ''), '')::int), 0) + 1 into n
  from qt_requests where no like pre || '-%' and no ~ ('^' || pre || '-\d+$');
  return pre || '-' || n;
end $$;

/*
 * An engineer's request: one hospital and equipment, one request number per spare (as the sheet).
 * p: {client_token, facility_id, equipment, make, model, serial, equipment_photo, note,
 *     spares: [{id, spare, part_no, qty, photos: []}]}; the ids are the photos' folders.
 */
create or replace function public.qt_raise(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); pp qt_people; f qt_facilities; s jsonb; r qt_requests; out jsonb := '[]'::jsonb;
begin
  select * into pp from qt_people where employee_id = me;
  if not found or pp.role not in ('engineer', 'team_lead') then raise exception 'Only an engineer or a Team Lead on the quotation tracker can raise a request.'; end if;
  if pp.role = 'engineer' and pp.team_lead_id is null then raise exception 'You have no Team Lead in the quotation tracker yet. Ask the Coordinator Lead to add one.'; end if;
  if nullif(p->>'client_token', '') is not null and exists (select 1 from qt_requests where client_token = p->>'client_token') then
    return (select jsonb_agg(no order by no) from qt_requests where client_token = p->>'client_token');
  end if;
  select * into f from qt_facilities where id = (p->>'facility_id')::uuid;
  if not found then raise exception 'Choose the hospital.'; end if;
  perform qt_need(p->>'equipment', 'equipment name');
  if jsonb_typeof(p->'spares') <> 'array' or jsonb_array_length(p->'spares') = 0 then raise exception 'Add a spare.'; end if;
  for s in select * from jsonb_array_elements(p->'spares') loop
    perform qt_need(s->>'spare', 'spare name');
    if coalesce((s->>'qty')::int, 0) < 1 then raise exception 'The quantity of % must be at least 1.', s->>'spare'; end if;
  end loop;
  for s in select * from jsonb_array_elements(p->'spares') loop
    insert into qt_requests (id, no, kind, step, engineer_id, team_lead_id, raised_by, client_token,
      facility_id, state, district, hospital, category, equipment, make, model, serial, equipment_photo,
      spare, part_no, qty, photos, engineer_note)
    values (coalesce((s->>'id')::uuid, gen_random_uuid()), qt_next_no('request'), 'request',
      case when pp.role = 'team_lead' then case when f.category = 'CAMC' then 'coord_pr' else 'coord_initial' end else 'tl_review' end,
      me, case when pp.role = 'team_lead' then me else pp.team_lead_id end, me, nullif(p->>'client_token', ''),
      f.id, f.state, f.district, f.name, f.category, btrim(p->>'equipment'), nullif(btrim(p->>'make'), ''), nullif(btrim(p->>'model'), ''),
      nullif(btrim(p->>'serial'), ''), nullif(p->>'equipment_photo', ''),
      btrim(s->>'spare'), nullif(btrim(s->>'part_no'), ''), (s->>'qty')::int,
      coalesce(array(select jsonb_array_elements_text(s->'photos')), '{}'), nullif(btrim(p->>'note'), ''))
    returning * into r;
    insert into qt_events (request_id, by, step, action, to_step, note) values (r.id, me, 'raised', 'raise', r.step, r.engineer_note);
    perform qt_tell_next(r, 'New spare request from ' || (select full_name from employees where id = me));
    out := out || to_jsonb(r.no);
  end loop;
  return out;
end $$;

/*
 * A Coordinator's stock request (STK): straight to Purchase dispatch, for a stakeholder who receives it.
 * p: {client_token, stakeholder_id, facility_id?, address, pr_no, pr_date, spares: [{id, item_code, spare, part_no, qty, photos}]}
 */
create or replace function public.qt_raise_stock(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); f qt_facilities; s jsonb; r qt_requests; out jsonb := '[]'::jsonb; who uuid := (p->>'stakeholder_id')::uuid;
begin
  if qt_role() is distinct from 'coordinator' then raise exception 'Only a Coordinator can raise a stock request.'; end if;
  if nullif(p->>'client_token', '') is not null and exists (select 1 from qt_requests where client_token = p->>'client_token') then
    return (select jsonb_agg(no order by no) from qt_requests where client_token = p->>'client_token');
  end if;
  if who is null or not exists (select 1 from qt_people where employee_id = who) then raise exception 'Choose who receives the stock.'; end if;
  perform qt_need(p->>'address', 'delivery address');
  perform qt_need(p->>'pr_no', 'PR number');
  if nullif(p->>'pr_date', '') is null then raise exception 'Choose the PR date.'; end if;
  if nullif(p->>'facility_id', '') is not null then select * into f from qt_facilities where id = (p->>'facility_id')::uuid; end if;
  if jsonb_typeof(p->'spares') <> 'array' or jsonb_array_length(p->'spares') = 0 then raise exception 'Add a spare.'; end if;
  for s in select * from jsonb_array_elements(p->'spares') loop
    perform qt_need(s->>'spare', 'spare name');
    if coalesce((s->>'qty')::int, 0) < 1 then raise exception 'The quantity of % must be at least 1.', s->>'spare'; end if;
  end loop;
  for s in select * from jsonb_array_elements(p->'spares') loop
    insert into qt_requests (id, no, kind, step, engineer_id, team_lead_id, raised_by, coord_id, client_token,
      facility_id, state, district, hospital, category, delivery_address, pr_no, pr_date,
      item_code, spare, part_no, qty, approved_qty, photos)
    values (coalesce((s->>'id')::uuid, gen_random_uuid()), qt_next_no('stock'), 'stock', 'purchase_dispatch',
      who, (select team_lead_id from qt_people where employee_id = who), me, me, nullif(p->>'client_token', ''),
      f.id, f.state, f.district, f.name, f.category, btrim(p->>'address'), btrim(p->>'pr_no'), (p->>'pr_date')::date,
      nullif(btrim(s->>'item_code'), ''), btrim(s->>'spare'), nullif(btrim(s->>'part_no'), ''), (s->>'qty')::int, (s->>'qty')::int,
      coalesce(array(select jsonb_array_elements_text(s->'photos')), '{}'))
    returning * into r;
    insert into qt_events (request_id, by, step, action, to_step) values (r.id, me, 'raised', 'raise_stock', r.step);
    perform qt_tell_next(r, 'New stock request');
    out := out || to_jsonb(r.no);
  end loop;
  return out;
end $$;

-- ------------------------------------------------------------- accept --

/* Accept one or many (idea 10): each its own event with the time it waited. */
create or replace function public.qt_accept(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); r qt_requests; n int := 0; want text;
begin
  for r in select * from qt_requests where id = any(p_ids) for update loop
    if not qt_can_act(r) or not qt_needs_accept(r.step) or r.accepted_at is not null then continue; end if;
    want := qt_role_of_step(r.step, r.kind);
    update qt_requests set accepted_by = me, accepted_at = now(),
      coord_id = case when want = 'coordinator' and coord_id is null then me else coord_id end,
      purchase_id = case when want = 'purchase' and purchase_id is null then me else purchase_id end,
      pv_id = case when r.step = 'pv' then me else pv_id end,
      tl_by = case when want = 'team_lead' then me else tl_by end
    where id = r.id;
    insert into qt_events (request_id, by, step, action, accept_s) values (r.id, me, r.step, 'accept', qt_secs(r.step_since, now()));
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Nothing to accept. It may already be accepted by someone else. Pull down to refresh.'; end if;
  return n;
end $$;

-- ------------------------------------------------------------- stages --

/* The engineer edits their own request while it still waits for the Team Lead. */
create or replace function public.qt_edit_own(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests;
begin
  select * into r from qt_requests where id = p_id for update;
  if not found or r.raised_by is distinct from current_employee_id() or r.step <> 'tl_review' or r.accepted_at is not null then
    raise exception 'This request can no longer be changed here.';
  end if;
  if coalesce((p->>'qty')::int, 0) < 1 then raise exception 'The quantity must be at least 1.'; end if;
  update qt_requests set equipment = qt_need(p->>'equipment', 'equipment name'), make = nullif(btrim(p->>'make'), ''),
    model = nullif(btrim(p->>'model'), ''), serial = nullif(btrim(p->>'serial'), ''),
    spare = qt_need(p->>'spare', 'spare name'), part_no = nullif(btrim(p->>'part_no'), ''), qty = (p->>'qty')::int
  where id = p_id;
  insert into qt_events (request_id, by, step, action, note) values (p_id, current_employee_id(), r.step, 'edit', 'Changed before the Team Lead accepted');
end $$;

/* Team Lead approves, with any correction; CAMC goes straight to PR (the script's rule). Many at once (idea 10). */
create or replace function public.qt_tl_approve(p_ids uuid[], p jsonb default null) returns int
language plpgsql security definer set search_path = public as $$
declare r qt_requests; i uuid; n int := 0; nxt text;
begin
  foreach i in array p_ids loop
    r := qt_get(i);
    if r.step <> 'tl_review' then raise exception '% is not waiting for approval.', r.no; end if;
    perform qt_check_accepted(r);
    if p is not null and array_length(p_ids, 1) = 1 then
      if coalesce((p->>'qty')::int, 0) < 1 then raise exception 'The quantity must be at least 1.'; end if;
      update qt_requests set equipment = qt_need(p->>'equipment', 'equipment name'), make = nullif(btrim(p->>'make'), ''),
        model = nullif(btrim(p->>'model'), ''), serial = nullif(btrim(p->>'serial'), ''),
        spare = qt_need(p->>'spare', 'spare name'), qty = (p->>'qty')::int where id = r.id;
    end if;
    nxt := case when upper(coalesce(r.category, '')) = 'CAMC' then 'coord_pr' else 'coord_initial' end;
    r := qt_move(r.id, 'approve', nxt, case when nxt = 'coord_pr' then 'CAMC: no pricing, straight to PR' end);
    perform qt_tell_next(r, 'Spare request approved by the Team Lead');
    n := n + 1;
  end loop;
  return n;
end $$;

/*
 * Coordinator at the first look: close (reason), ask the Team Lead (clarification), ask Purchase for rates,
 * or give the SAP rate and either send it to Purchase to confirm or go straight to PR.
 * p: {action: close|ask_tl|to_purchase|sap_confirm|sap_pr, note, vendor, rate, tax}
 */
create or replace function public.qt_coord_initial(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_initial' then raise exception '% is not at the Coordinator''s first look.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'close' then
    r := qt_move(p_id, 'close', 'closed', qt_need(p->>'note', 'reason for closing'), true);
    update qt_requests set close_note = btrim(p->>'note') where id = p_id;
    perform qt_tell_next(r, 'Your spare request was closed by the Coordinator');
  elsif a = 'ask_tl' then
    r := qt_move(p_id, 'ask', 'tl_clarify', qt_need(p->>'note', 'question for the Team Lead'));
    perform qt_tell_next(r, 'The Coordinator asks about a spare request');
  elsif a = 'to_purchase' then
    r := qt_move(p_id, 'to_purchase', 'purchase_rates', p->>'note');
    perform qt_tell_next(r, 'Rates needed');
  elsif a in ('sap_confirm', 'sap_pr') then
    if coalesce((p->>'rate')::numeric, 0) <= 0 then raise exception 'Write the SAP rate.'; end if;
    if p->>'tax' is null or (p->>'tax')::numeric < 0 then raise exception 'Write the tax %% (0 if none).'; end if;
    update qt_requests set sap = true, orig_vendor = qt_need(p->>'vendor', 'vendor'), orig_rate = (p->>'rate')::numeric,
      orig_tax = (p->>'tax')::numeric where id = p_id;
    if a = 'sap_pr' then
      update qt_requests set picked = 'original' where id = p_id;
      r := qt_move(p_id, 'sap_pr', 'coord_pr', p->>'note');
    else
      r := qt_move(p_id, 'sap_confirm', 'purchase_rates', p->>'note');
      perform qt_tell_next(r, 'SAP rate to confirm');
    end if;
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

/* Team Lead answers the Coordinator, correcting the request if needed; it goes back to the Coordinator. */
create or replace function public.qt_tl_reply(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'tl_clarify' then raise exception '% has no question for you.', r.no; end if;
  perform qt_check_accepted(r);
  if p ? 'spare' then
    if coalesce((p->>'qty')::int, 0) < 1 then raise exception 'The quantity must be at least 1.'; end if;
    update qt_requests set equipment = qt_need(p->>'equipment', 'equipment name'), make = nullif(btrim(p->>'make'), ''),
      model = nullif(btrim(p->>'model'), ''), serial = nullif(btrim(p->>'serial'), ''),
      spare = qt_need(p->>'spare', 'spare name'), qty = (p->>'qty')::int where id = p_id;
  end if;
  r := qt_move(p_id, 'reply', 'coord_initial', qt_need(p->>'note', 'answer'));
  perform qt_tell_next(r, 'The Team Lead answered');
end $$;

/*
 * Purchase rates. p: {action: rates|rates_pr|approve_sap|ask, note, orig_vendor, orig_rate, orig_tax, orig_photo,
 *   comp_vendor, comp_rate, comp_tax, comp_photo, warranty, lead_days}
 * rates → PV; rates_pr → straight to the Coordinator's PR (the script's "Process PR"); approve_sap keeps the SAP rate;
 * ask → back to the Coordinator with a question. A request quotes both original and compatible; stock only one.
 */
create or replace function public.qt_purchase_rates(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'purchase_rates' then raise exception '% is not waiting for rates.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'ask' then
    r := qt_move(p_id, 'ask', 'coord_initial', qt_need(p->>'note', 'question for the Coordinator'));
    perform qt_tell_next(r, 'Purchase asks about a request');
    return;
  end if;
  if a = 'approve_sap' then
    if not r.sap or coalesce(r.orig_rate, 0) <= 0 then raise exception 'There is no SAP rate on % to approve.', r.no; end if;
    update qt_requests set picked = 'original', purchase_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'approve_sap', 'coord_pr', p->>'note');
    perform qt_tell_next(r, 'SAP rate approved, PR to raise');
    return;
  end if;
  if a not in ('rates', 'rates_pr') then raise exception 'Choose what to do.'; end if;
  if coalesce((p->>'comp_rate')::numeric, 0) <= 0 then raise exception 'Write the compatible rate.'; end if;
  if p->>'comp_tax' is null then raise exception 'Write the compatible tax %% (0 if none).'; end if;
  if r.kind = 'request' then
    if coalesce((p->>'orig_rate')::numeric, 0) <= 0 then raise exception 'Write the original rate.'; end if;
    if p->>'orig_tax' is null then raise exception 'Write the original tax %% (0 if none).'; end if;
  end if;
  update qt_requests set
    orig_vendor = case when r.kind = 'request' then qt_need(p->>'orig_vendor', 'original vendor') end,
    orig_rate = case when r.kind = 'request' then (p->>'orig_rate')::numeric end,
    orig_tax = case when r.kind = 'request' then (p->>'orig_tax')::numeric end,
    orig_photo = case when r.kind = 'request' then coalesce(nullif(p->>'orig_photo', ''), orig_photo) end,
    comp_vendor = qt_need(p->>'comp_vendor', 'compatible vendor'), comp_rate = (p->>'comp_rate')::numeric,
    comp_tax = (p->>'comp_tax')::numeric, comp_photo = coalesce(nullif(p->>'comp_photo', ''), comp_photo),
    warranty = nullif(btrim(p->>'warranty'), ''), lead_days = nullif(p->>'lead_days', '')::int,
    purchase_note = nullif(btrim(p->>'note'), ''), sap = false,
    picked = case when r.kind = 'stock' then 'compatible' end
  where id = p_id;
  if a = 'rates_pr' or r.kind = 'stock' then
    r := qt_move(p_id, 'rates_pr', 'coord_pr', p->>'note');
    perform qt_tell_next(r, 'Rates in, PR to raise');
  else
    r := qt_move(p_id, 'rates', 'pv', p->>'note');
    perform qt_tell_next(r, 'Price verification needed');
  end if;
end $$;

/* PV picks original or compatible (one press, idea 9), or returns the rates to Purchase with what to revise. */
create or replace function public.qt_pv(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'pv' then raise exception '% is not waiting for price verification.', r.no; end if;
  perform qt_check_accepted(r);
  if a in ('original', 'compatible') then
    update qt_requests set picked = a where id = p_id;
    r := qt_move(p_id, 'pick_' || a, 'coord_pr', p->>'note');
    perform qt_tell_next(r, 'Rates verified, PR to raise');
  elsif a = 'return' then
    r := qt_move(p_id, 'return', 'purchase_rates', qt_need(p->>'note', 'what to revise'));
    perform qt_tell_next(r, 'PV asks to revise the rates');
  else
    raise exception 'Choose original or compatible.';
  end if;
end $$;

/*
 * Coordinator at PR: quotation only, cancel, hold, or the PR to Purchase for PO and dispatch.
 * p: {action: quotation|cancel|hold|pr, note, quote_submitted, quote_approved, pr_no, pr_date, item_code, approved_qty}
 */
create or replace function public.qt_coord_pr(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_pr' then raise exception '% is not waiting for a PR.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'quotation' then
    update qt_requests set quote_submitted = nullif(p->>'quote_submitted', '')::date, quote_approved = nullif(p->>'quote_approved', '')::date,
      coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'quotation', 'quotation_only', p->>'note', true);
    perform qt_tell_next(r, 'Your spare request was closed as quotation only');
  elsif a = 'cancel' then
    r := qt_move(p_id, 'cancel', 'cancelled', qt_need(p->>'note', 'reason for cancelling'), true);
    update qt_requests set close_note = btrim(p->>'note') where id = p_id;
    perform qt_tell_next(r, 'Your spare request was cancelled');
  elsif a = 'hold' then
    update qt_requests set hold_from = 'coord_pr' where id = p_id;
    r := qt_move(p_id, 'hold', 'on_hold', qt_need(p->>'note', 'reason for the hold'));
  elsif a = 'pr' then
    if coalesce((p->>'approved_qty')::int, 0) < 1 then raise exception 'Write the approved quantity.'; end if;
    if nullif(p->>'pr_date', '') is null then raise exception 'Choose the PR date.'; end if;
    update qt_requests set quote_submitted = nullif(p->>'quote_submitted', '')::date, quote_approved = nullif(p->>'quote_approved', '')::date,
      pr_no = qt_need(p->>'pr_no', 'PR number'), pr_date = (p->>'pr_date')::date, item_code = nullif(btrim(p->>'item_code'), ''),
      approved_qty = (p->>'approved_qty')::int, coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'pr', 'purchase_dispatch', p->>'note');
    perform qt_tell_next(r, 'PR raised, PO and dispatch needed');
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

/* A hold ends where it began. */
create or replace function public.qt_resume(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); back text;
begin
  if r.step not in ('on_hold', 'on_hold_dispatch') then raise exception '% is not on hold.', r.no; end if;
  back := case when r.step = 'on_hold_dispatch' then 'purchase_dispatch' else coalesce(r.hold_from, 'coord_pr') end;
  r := qt_move(p_id, 'resume', back, null);
  update qt_requests set hold_from = null where id = p_id;
  perform qt_tell_next(r, 'Request back from hold');
end $$;

/*
 * Purchase PO and dispatch. p: {action: save|dispatch|ask_hold|ask_cancel, po_no, po_date, vendor, item_code, track_mode, track_no, note}
 * save keeps it with Purchase; dispatch needs the tracking and goes to whoever receives it.
 */
create or replace function public.qt_purchase_dispatch(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'purchase_dispatch' then raise exception '% is not waiting for dispatch.', r.no; end if;
  perform qt_check_accepted(r);
  if a in ('ask_hold', 'ask_cancel') then
    r := qt_move(p_id, a, 'coord_decide', qt_need(p->>'note', 'reason'));
    perform qt_tell_next(r, case a when 'ask_hold' then 'Purchase asks to hold a PR' else 'Purchase asks to cancel a PR' end);
    return;
  end if;
  update qt_requests set po_no = coalesce(nullif(btrim(p->>'po_no'), ''), po_no), po_date = coalesce(nullif(p->>'po_date', '')::date, po_date),
    vendor = coalesce(nullif(btrim(p->>'vendor'), ''), vendor), item_code = coalesce(nullif(btrim(p->>'item_code'), ''), item_code),
    dispatch_note = coalesce(nullif(btrim(p->>'note'), ''), dispatch_note)
  where id = p_id;
  if a = 'save' then
    insert into qt_events (request_id, by, step, action, note) values (p_id, current_employee_id(), r.step, 'save_po', nullif(btrim(p->>'note'), ''));
  elsif a = 'dispatch' then
    select * into r from qt_requests where id = p_id;
    if r.po_no is null then raise exception 'Write the PO number.'; end if;
    update qt_requests set track_mode = qt_need(p->>'track_mode', 'how it is sent'), track_no = qt_need(p->>'track_no', 'tracking number'),
      dispatched_at = now() where id = p_id;
    r := qt_move(p_id, 'dispatch', 'receipt', p->>'note');
    perform qt_tell_next(r, 'Your spare is dispatched');
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

/* Coordinator decides on Purchase's hold or cancel ask. p: {action: cancel|hold|deny, note} */
create or replace function public.qt_coord_decide(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_decide' then raise exception '% has nothing to decide.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'cancel' then
    r := qt_move(p_id, 'cancel', 'cancelled', p->>'note', true);
    update qt_requests set close_note = coalesce(nullif(btrim(p->>'note'), ''), 'Cancelled on Purchase''s request') where id = p_id;
    perform qt_tell_next(r, 'Your spare request was cancelled');
  elsif a = 'hold' then
    r := qt_move(p_id, 'hold', 'on_hold_dispatch', p->>'note');
  elsif a = 'deny' then
    r := qt_move(p_id, 'deny', 'purchase_dispatch', qt_need(p->>'note', 'reason'));
    perform qt_tell_next(r, 'The Coordinator says go ahead with the dispatch');
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

/*
 * Receipt on one screen (idea 8): received, used and faulty now; the rest is worked out.
 * p: {received, used, faulty, faulty_kind (Faulty|Mismatch), observe (bool), date, note}
 * A replacement (faulty earlier) does not add to received; it takes from the faulty count.
 */
create or replace function public.qt_receipt(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); got int := coalesce((p->>'received')::int, 0); used int := coalesce((p->>'used')::int, 0);
  bad int := coalesce((p->>'faulty')::int, 0); repl boolean; nrec int; nfault int; nused int; nxt text; d date := coalesce(nullif(p->>'date', '')::date, (now() at time zone 'Asia/Kolkata')::date);
begin
  if r.step not in ('receipt', 'observation') then raise exception '% is not waiting for your receipt.', r.no; end if;
  perform qt_check_accepted(r);
  if got < 1 and r.step = 'receipt' then raise exception 'Write how many you received.'; end if;
  if used < 0 or bad < 0 or got < 0 then raise exception 'Quantities cannot be below 0.'; end if;
  if used + bad > got + (case when r.step = 'observation' then r.received_qty - r.used_qty - r.faulty_qty else 0 end) then
    raise exception 'Used and faulty together cannot be more than received.';
  end if;
  if d > (now() at time zone 'Asia/Kolkata')::date then raise exception 'The date cannot be in the future.'; end if;
  if bad > 0 and coalesce(p->>'faulty_kind', '') not in ('Faulty', 'Mismatch') then raise exception 'Choose faulty or mismatch.'; end if;
  repl := r.faulty_qty > 0 and r.step = 'receipt';
  nrec := case when repl then r.received_qty else r.received_qty + got end;
  nfault := case when repl then greatest(0, r.faulty_qty - got) + bad else r.faulty_qty + bad end;
  nused := r.used_qty + used;
  nxt := case when coalesce((p->>'observe')::boolean, false) then 'observation' when nfault > 0 then 'purchase_faulty' else 'completed' end;
  update qt_requests set received_qty = nrec, used_qty = nused, faulty_qty = nfault, received_on = d,
    faulty_kind = case when bad > 0 then p->>'faulty_kind' when nfault = 0 then null else faulty_kind end,
    faulty_note = case when bad > 0 then nullif(btrim(p->>'note'), '') else faulty_note end
  where id = p_id;
  r := qt_move(p_id, case when repl then 'replacement_received' else 'received' end, nxt,
               concat_ws(' · ', got || ' received', case when used > 0 then used || ' used' end, case when bad > 0 then bad || ' ' || lower(p->>'faulty_kind') end, nullif(btrim(p->>'note'), '')),
               nxt = 'completed');
  if nxt = 'purchase_faulty' then perform qt_tell_next(r, coalesce(p->>'faulty_kind', 'Faulty') || ' spare reported'); end if;
end $$;

/* Purchase on a faulty or mismatched spare. p: {action: cancel|stock|return, address, note} */
create or replace function public.qt_purchase_faulty(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'purchase_faulty' then raise exception '% has no faulty spare waiting.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'cancel' then
    update qt_requests set faulty_action = 'Cancel PO' where id = p_id;
    r := qt_move(p_id, 'cancel_po', 'cancelled', p->>'note', true);
    perform qt_tell_next(r, 'PO cancelled for your faulty spare');
  elsif a = 'stock' then
    update qt_requests set faulty_action = 'To stock' where id = p_id;
    r := qt_move(p_id, 'to_stock', 'moved_to_stock', p->>'note', true);
  elsif a = 'return' then
    update qt_requests set faulty_action = 'Return', return_address = qt_need(p->>'address', 'return address') where id = p_id;
    r := qt_move(p_id, 'return', 'return_dispatch', p->>'note');
    perform qt_tell_next(r, 'Send the faulty spare back');
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

/* The faulty spare sent back. p: {track_mode, track_no} */
create or replace function public.qt_return_dispatch(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'return_dispatch' then raise exception '% is not waiting for a return.', r.no; end if;
  perform qt_check_accepted(r);
  update qt_requests set return_track_mode = qt_need(p->>'track_mode', 'how it is sent'), return_track_no = qt_need(p->>'track_no', 'tracking number') where id = p_id;
  r := qt_move(p_id, 'returned', 'purchase_replacement', p->>'note');
  perform qt_tell_next(r, 'Faulty spare sent back');
end $$;

/* Purchase dispatches the replacement. p: {track_mode, track_no, note} */
create or replace function public.qt_replacement(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'purchase_replacement' then raise exception '% is not waiting for a replacement.', r.no; end if;
  perform qt_check_accepted(r);
  update qt_requests set track_mode = qt_need(p->>'track_mode', 'how it is sent'), track_no = qt_need(p->>'track_no', 'tracking number'),
    dispatched_at = now() where id = p_id;
  r := qt_move(p_id, 'replacement', 'receipt', p->>'note');
  perform qt_tell_next(r, 'Your replacement spare is dispatched');
end $$;

/* Reopen: the Coordinator a quotation-only request back to PR; the engineer a completed one back to receipt. */
create or replace function public.qt_reopen(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests; me uuid := current_employee_id(); nxt text;
begin
  select * into r from qt_requests where id = p_id for update;
  if not found or not qt_sees(r) then raise exception 'Request not found.'; end if;
  if r.step = 'quotation_only' and qt_role() = 'coordinator' then nxt := 'coord_pr';
  elsif r.step = 'completed' and r.engineer_id = me then nxt := 'receipt';
  else raise exception 'This request cannot be reopened by you.'; end if;
  insert into qt_events (request_id, by, step, action, to_step, note) values (p_id, me, r.step, 'reopen', nxt, qt_need(p_note, 'reason for reopening'));
  update qt_requests set step = nxt, step_since = now(), accepted_by = me, accepted_at = now(), done = false, closed_at = null,
    coord_id = case when nxt = 'coord_pr' then me else coord_id end where id = p_id;
end $$;

/* A note on the request's thread (idea 11), to whoever works it now. */
create or replace function public.qt_note(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests;
begin
  select * into r from qt_requests where id = p_id;
  if not found or not qt_sees(r) then raise exception 'Request not found.'; end if;
  insert into qt_events (request_id, by, step, action, note) values (p_id, current_employee_id(), r.step, 'note', qt_need(p_note, 'note'));
  if not r.done then perform qt_tell_next(r, 'A note on ' || r.no); end if;
end $$;

/* Stock register: spares used from what is in hand (received − used − faulty). */
create or replace function public.qt_consume(p_id uuid, p_qty int, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests;
begin
  select * into r from qt_requests where id = p_id for update;
  if not found or r.engineer_id is distinct from current_employee_id() then raise exception 'Only the person holding this stock can use it.'; end if;
  if r.step not in ('completed', 'observation') then raise exception '% is not in your stock.', r.no; end if;
  if coalesce(p_qty, 0) < 1 or p_qty > r.received_qty - r.used_qty - r.faulty_qty then
    raise exception 'You can use 1 to % of %.', r.received_qty - r.used_qty - r.faulty_qty, r.no;
  end if;
  update qt_requests set used_qty = used_qty + p_qty where id = p_id;
  insert into qt_events (request_id, by, step, action, note) values (p_id, current_employee_id(), r.step, 'consume', p_qty || ' used · ' || qt_need(p_note, 'where it was used'));
end $$;

-- ------------------------------------------------------- facilities --

create or replace function public.qt_save_facility(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); f qt_facilities; nid uuid; cat text := coalesce(nullif(p->>'category', ''), 'AMC');
begin
  if qt_role() is distinct from 'coordinator' and not qt_is_lead() then raise exception 'Only a Coordinator can add or change hospitals.'; end if;
  if cat not in ('AMC', 'CAMC', 'CAMC & AMC') then raise exception 'Choose AMC or CAMC.'; end if;
  if nullif(p->>'id', '') is null then
    insert into qt_facilities (state, district, name, category, created_by)
    values (qt_need(p->>'state', 'state'), coalesce(btrim(p->>'district'), ''), qt_need(p->>'name', 'hospital name'), cat, me)
    returning id into nid;
    insert into qt_facility_log (facility_id, by, action, after) values (nid, me, 'add', p);
  else
    select * into f from qt_facilities where id = (p->>'id')::uuid for update;
    if not found then raise exception 'Hospital not found.'; end if;
    update qt_facilities set state = qt_need(p->>'state', 'state'), district = coalesce(btrim(p->>'district'), ''),
      name = qt_need(p->>'name', 'hospital name'), category = cat, updated_by = me, updated_at = now() where id = f.id;
    insert into qt_facility_log (facility_id, by, action, before, after) values (f.id, me, 'edit', to_jsonb(f), p);
    nid := f.id;
  end if;
  return nid;
exception when unique_violation then
  raise exception 'This hospital is already in the list.';
end $$;

-- ----------------------------------------------------- people, targets --

create or replace function public.qt_save_person(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare who uuid; tl uuid;
begin
  if not qt_is_lead() then raise exception 'Only a lead can change people.'; end if;
  select id into who from employees where upper(ecode) = upper(btrim(p->>'ecode')) and is_active;
  if who is null then raise exception 'No active employee %.', p->>'ecode'; end if;
  if coalesce(p->>'role', '') not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv') then raise exception 'Choose the role.'; end if;
  if p->>'role' = 'engineer' then
    select id into tl from employees where upper(ecode) = upper(btrim(p->>'team_lead_ecode'));
    if tl is null or not exists (select 1 from qt_people where employee_id = tl and role = 'team_lead') then raise exception 'Choose the Team Lead.'; end if;
  end if;
  insert into qt_people (employee_id, role, is_lead, team_lead_id, added_by)
  values (who, p->>'role', coalesce((p->>'lead')::boolean, false), tl, current_employee_id())
  on conflict (employee_id) do update set role = excluded.role, is_lead = excluded.is_lead, team_lead_id = excluded.team_lead_id;
end $$;

create or replace function public.qt_remove_person(p_employee uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not qt_is_lead() then raise exception 'Only a lead can change people.'; end if;
  if exists (select 1 from qt_requests where not done and (engineer_id = p_employee or team_lead_id = p_employee or
       (accepted_by = p_employee))) then
    raise exception 'This person still has open requests. Move them first.';
  end if;
  delete from qt_people where employee_id = p_employee;
end $$;

create or replace function public.qt_save_targets(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb;
begin
  if not qt_is_lead() then raise exception 'Only a lead can change the targets.'; end if;
  for k, v in select * from jsonb_each(p) loop
    if coalesce((v->>'accept_h')::numeric, 0) <= 0 or coalesce((v->>'process_h')::numeric, 0) <= 0 then raise exception 'Every target must be above 0 hours.'; end if;
    update qt_stage_targets set accept_h = (v->>'accept_h')::numeric, process_h = (v->>'process_h')::numeric where step = k;
  end loop;
end $$;

-- ------------------------------------------------------------ photos --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('qt-photos', 'qt-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do nothing;

/* One folder per request; a request being raised has no row yet, and a member may fill its folder. */
create or replace function public.qt_photo_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare rid uuid; r qt_requests;
begin
  begin rid := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  select * into r from qt_requests where id = rid;
  if not found then return p_write and qt_me() is not null; end if;
  return qt_sees(r);
end $$;

drop policy if exists qt_photos_insert on storage.objects;
create policy qt_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'qt-photos' and public.qt_photo_ok(name, true));
drop policy if exists qt_photos_read on storage.objects;
create policy qt_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'qt-photos' and public.qt_photo_ok(name, false));

-- ------------------------------------------------------- bell: bemmp --
alter table public.push_messages drop constraint if exists push_messages_kind_check;
alter table public.push_messages add constraint push_messages_kind_check
  check (kind in ('manual', 'reminder', 'travel', 'ops', 'module', 'bemmp'));

create or replace function public.message_app(p_url text)
returns text language sql immutable as $$
  select case
    when coalesce(p_url, '') in ('', '/') or p_url like '/kpi%' then 'kpi'
    when p_url like '/travel%' then 'travel'
    when p_url like '/bemmp%' then 'bemmp'
  end
$$;

-- ------------------------------------------------------------ grants --
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'qt\_%' loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
-- Internal: not callable from the app.
revoke execute on function public.qt_move(uuid, text, text, text, boolean), public.qt_tell(uuid, text, text, uuid),
  public.qt_tell_role(text, text, text, uuid), public.qt_tell_next(public.qt_requests, text), public.qt_next_no(text)
  from authenticated;

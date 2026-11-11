/*
 * An observer looks after one role's people (the user, 11 Nov): Purchase's observer sees the Purchase team on the
 * dashboard, with a member filter and the TAT of Purchase's own stages. observes = that role; empty = every role.
 */
alter table public.qt_people add column if not exists observes text
  check (observes is null or observes in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv'));

create or replace function public.qt_save_person(p jsonb) returns void
language plpgsql security definer set search_path to 'public' as $$
declare who uuid; tl uuid; obs text := nullif(p->>'observes', '');
begin
  if not qt_is_lead() then raise exception 'Only a lead can change people.'; end if;
  select id into who from employees where upper(ecode) = upper(btrim(p->>'ecode')) and is_active;
  if who is null then raise exception 'No active employee %.', p->>'ecode'; end if;
  if coalesce(p->>'role', '') not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer') then raise exception 'Choose the role.'; end if;
  if p->>'role' = 'engineer' then
    select id into tl from employees where upper(ecode) = upper(btrim(p->>'team_lead_ecode'));
    if tl is null or not exists (select 1 from qt_people where employee_id = tl and role = 'team_lead') then raise exception 'Choose the Team Lead.'; end if;
  end if;
  if p->>'role' <> 'observer' then obs := null; end if;
  if obs is not null and obs not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv') then raise exception 'Choose the team observed.'; end if;
  insert into qt_people (employee_id, role, is_lead, team_lead_id, added_by, observes)
  values (who, p->>'role', coalesce((p->>'lead')::boolean, false), tl, current_employee_id(), obs)
  on conflict (employee_id) do update set role = excluded.role, is_lead = excluded.is_lead, team_lead_id = excluded.team_lead_id, observes = excluded.observes;
end $$;

create or replace function public.qt_people_list() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', p.employee_id, 'name', e.full_name, 'ecode', e.ecode, 'role', p.role,
           'lead', p.is_lead, 'team_lead_id', p.team_lead_id, 'team_lead_name', t.full_name, 'team_lead_ecode', t.ecode,
           'active', e.is_active, 'designation', e.designation, 'observes', p.observes)
           order by p.role, e.full_name), '[]'::jsonb)
  from qt_people p join employees e on e.id = p.employee_id left join employees t on t.id = p.team_lead_id
  where qt_me() is not null or coalesce(public.is_sw_admin(), false)
$$;

create or replace function public.qt_me() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case
    when current_employee_id() is null then null
    when exists (select 1 from qt_people where employee_id = current_employee_id())
      then (select jsonb_build_object('id', p.employee_id, 'name', (select full_name from employees where id = p.employee_id),
              'role', p.role, 'observes', p.observes, 'lead', p.is_lead or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
              'team_lead_id', p.team_lead_id, 'team_lead_name', (select full_name from employees where id = p.team_lead_id))
            from qt_people p where p.employee_id = current_employee_id())
    when coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
      then jsonb_build_object('id', current_employee_id(), 'role', 'viewer', 'lead', true)
  end
$$;

/* Observers see their team's events (or everyone's when they observe every role). */
create or replace function public.qt_events_in(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('request_id', v.request_id, 'no', r.no, 'at', v.at, 'step', v.step, 'action', v.action,
           'to_step', v.to_step, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by', v.by, 'by_name', b.full_name, 'by_code', b.ecode,
           'by_role', q.role) order by v.at), '[]'::jsonb)
  from qt_events v join qt_requests r on r.id = v.request_id left join employees b on b.id = v.by left join qt_people q on q.employee_id = v.by
  where qt_sees(r)
    and (qt_is_lead() or v.by = current_employee_id()
         or exists (select 1 from qt_people o where o.employee_id = current_employee_id() and o.role = 'observer'
                    and (o.observes is null or o.observes = q.role)))
    and (p_from is null or (v.at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (v.at at time zone 'Asia/Kolkata')::date <= p_to)
$$;

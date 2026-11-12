-- 0051: the Quotation tracker history and Medtronic lists check who you are once, not on every row
-- (the user, 12 Nov: "check other modules also for slowness"). qt_events_in ran qt_sees for each of 1,926
-- events (0.3–1.6 s); now once per request (162). mt_data ran mt_sees, with in_scope and mt_sees_all inside,
-- for each ticket (0.4–0.6 s). Same results, checked user by user before applying.

create or replace function public.qt_events_in(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with me as materialized (
    select current_employee_id() as me, qt_is_lead() as lead,
      -- qt_people is one row a person (its key), so "an observer row" and "its observes" read once.
      exists (select 1 from qt_people o where o.employee_id = current_employee_id() and o.role = 'observer') as observer,
      (select o.observes from qt_people o where o.employee_id = current_employee_id() and o.role = 'observer') as observes
  ), seen as materialized (
    select r.id, r.no from qt_requests r where qt_sees(r)
  )
  select coalesce(jsonb_agg(jsonb_build_object('request_id', v.request_id, 'no', r.no, 'at', v.at, 'step', v.step, 'action', v.action,
           'to_step', v.to_step, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by', v.by, 'by_name', b.full_name, 'by_code', b.ecode,
           'by_role', q.role) order by v.at), '[]'::jsonb)
  from qt_events v join seen r on r.id = v.request_id left join employees b on b.id = v.by left join qt_people q on q.employee_id = v.by
  cross join me
  where (me.lead or v.by = me.me
         or (q.role = 'engineer' and q.team_lead_id = me.me)
         or (me.observer and (me.observes is null or me.observes = q.role)))
    and (p_from is null or (v.at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (v.at at time zone 'Asia/Kolkata')::date <= p_to)
$$;

create or replace function public.mt_data()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  -- mt_sees(manager, engineer), read once: in scope and (the manager, the engineer, the manager's manager, or sees all).
  with me as materialized (
    select current_employee_id() as me, in_scope('mt') as scope, mt_sees_all() as all_
  )
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
      cross join me
      where me.scope and (t.manager_id = me.me or t.engineer_id = me.me or m.reporting_manager_id = me.me or me.all_)), '[]'::jsonb),
    'team', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'ecode', e.ecode, 'name', e.full_name) order by e.full_name)
      from employees e
      where e.reporting_manager_id = current_employee_id() and e.is_active
        and in_scope('mt') and exists (select 1 from mt_managers k where k.employee_id = current_employee_id())), '[]'::jsonb),
    'uploads', coalesce((
      select jsonb_agg(to_jsonb(u) order by u.uploaded_at desc)
      from (select u.*, e.full_name as uploaded_by_name
            from mt_uploads u join employees e on e.id = u.uploaded_by
            left join employees um on um.id = u.manager_id
            cross join me
            where me.scope and (u.manager_id = me.me or um.reporting_manager_id = me.me or me.all_)
            order by u.uploaded_at desc limit 20) u), '[]'::jsonb)
  );
$$;

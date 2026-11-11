/* Dashboard (the user, 11 Nov): events carry where they went; qt_me says who I am. */
create or replace function public.qt_events_in(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('request_id', v.request_id, 'no', r.no, 'at', v.at, 'step', v.step, 'action', v.action,
           'to_step', v.to_step, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by', v.by, 'by_name', b.full_name, 'by_code', b.ecode,
           'by_role', (select role from qt_people where employee_id = v.by)) order by v.at), '[]'::jsonb)
  from qt_events v join qt_requests r on r.id = v.request_id left join employees b on b.id = v.by
  where qt_sees(r)
    and (qt_is_lead() or v.by = current_employee_id())
    and (p_from is null or (v.at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (v.at at time zone 'Asia/Kolkata')::date <= p_to)
$$;

create or replace function public.qt_me() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case
    when current_employee_id() is null then null
    when exists (select 1 from qt_people where employee_id = current_employee_id())
      then (select jsonb_build_object('id', p.employee_id, 'name', (select full_name from employees where id = p.employee_id),
              'role', p.role, 'lead', p.is_lead or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
              'team_lead_id', p.team_lead_id, 'team_lead_name', (select full_name from employees where id = p.team_lead_id))
            from qt_people p where p.employee_id = current_employee_id())
    when coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
      then jsonb_build_object('id', current_employee_id(), 'role', 'viewer', 'lead', true)
  end
$$;

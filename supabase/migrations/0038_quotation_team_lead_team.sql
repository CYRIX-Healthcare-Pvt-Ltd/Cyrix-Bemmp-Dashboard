/* A Team Lead sees their own engineers' events on the dashboard (the user, 11 Nov); others only their own, observers their team. */
create or replace function public.qt_events_in(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('request_id', v.request_id, 'no', r.no, 'at', v.at, 'step', v.step, 'action', v.action,
           'to_step', v.to_step, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by', v.by, 'by_name', b.full_name, 'by_code', b.ecode,
           'by_role', q.role) order by v.at), '[]'::jsonb)
  from qt_events v join qt_requests r on r.id = v.request_id left join employees b on b.id = v.by left join qt_people q on q.employee_id = v.by
  where qt_sees(r)
    and (qt_is_lead() or v.by = current_employee_id()
         or (q.role = 'engineer' and q.team_lead_id = current_employee_id())
         or exists (select 1 from qt_people o where o.employee_id = current_employee_id() and o.role = 'observer'
                    and (o.observes is null or o.observes = q.role)))
    and (p_from is null or (v.at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (v.at at time zone 'Asia/Kolkata')::date <= p_to)
$$;

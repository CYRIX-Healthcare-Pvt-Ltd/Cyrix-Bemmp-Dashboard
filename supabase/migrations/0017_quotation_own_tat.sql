-- Quotation tracker: each person sees only their own TAT; leads see everyone (the user, 11 Nov 2026).
create or replace function public.qt_events_in(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('request_id', v.request_id, 'no', r.no, 'at', v.at, 'step', v.step, 'action', v.action,
           'accept_s', v.accept_s, 'process_s', v.process_s, 'by', v.by, 'by_name', b.full_name, 'by_code', b.ecode) order by v.at), '[]'::jsonb)
  from qt_events v join qt_requests r on r.id = v.request_id left join employees b on b.id = v.by
  where qt_sees(r)
    and (qt_is_lead() or v.by = current_employee_id())
    and (p_from is null or (v.at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (v.at at time zone 'Asia/Kolkata')::date <= p_to)
$$;
revoke all on function public.qt_events_in(date, date) from public, anon;
grant execute on function public.qt_events_in(date, date) to authenticated;

-- Quotation tracker → Quotations → Tracker: REQUESTED DATE is when the Team Lead approved the request, since only then
-- does it reach the Coordinator (the user, 26 Nov). Coordinators do not see the Team Lead's events (qt_events_in), so
-- this gives just that moment for every request the caller may see.
create or replace function public.qt_tl_approved_at()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(x.request_id, x.at), '{}'::jsonb)
  from (
    select v.request_id, min(v.at) as at
    from qt_events v join qt_requests r on r.id = v.request_id
    where v.step = 'tl_review' and v.action = 'approve' and qt_sees(r)
    group by v.request_id
  ) x
$$;

revoke all on function public.qt_tl_approved_at() from public, anon;
grant execute on function public.qt_tl_approved_at() to authenticated;

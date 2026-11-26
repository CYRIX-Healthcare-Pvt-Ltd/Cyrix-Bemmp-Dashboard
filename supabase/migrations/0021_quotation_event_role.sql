-- Quotation tracker: each timeline event carries the role of who did it, for its colour (the user, 11 Nov 2026).
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
                 'note', v.note, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by_name', b.full_name, 'by_code', b.ecode, 'by_role', q.role) order by v.at, v.id)
               from qt_events v left join employees b on b.id = v.by left join qt_people q on q.employee_id = v.by where v.request_id = r.id), '[]'::jsonb));
end $$;

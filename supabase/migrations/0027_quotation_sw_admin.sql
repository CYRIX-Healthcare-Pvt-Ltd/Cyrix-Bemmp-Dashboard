/*
 * SW Admin sets Quotation tracker roles from KPI's SW Admin → BEMMP tab
 * (the user, 11 Nov): SW Admin counts as a lead here, so qt_save_person,
 * qt_remove_person and qt_people_list work for it without being on the list.
 */
create or replace function public.qt_is_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_lead from qt_people where employee_id = current_employee_id()), false)
    or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
    or coalesce(public.is_sw_admin(), false)
$$;

create or replace function public.qt_people_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', p.employee_id, 'name', e.full_name, 'ecode', e.ecode, 'role', p.role,
           'lead', p.is_lead, 'team_lead_id', p.team_lead_id, 'team_lead_name', t.full_name, 'team_lead_ecode', t.ecode,
           'active', e.is_active, 'designation', e.designation)
           order by p.role, e.full_name), '[]'::jsonb)
  from qt_people p join employees e on e.id = p.employee_id left join employees t on t.id = p.team_lead_id
  where qt_me() is not null or coalesce(public.is_sw_admin(), false)
$$;

revoke all on function public.qt_is_lead() from public, anon;
grant execute on function public.qt_is_lead() to authenticated;
revoke all on function public.qt_people_list() from public, anon;
grant execute on function public.qt_people_list() to authenticated;

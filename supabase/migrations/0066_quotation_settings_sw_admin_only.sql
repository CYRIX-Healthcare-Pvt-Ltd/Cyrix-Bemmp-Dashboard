/*
  0066 (the user, 18 Nov: "why setting for coord?, not needed for pur, tl, pv, only sw admin"): qt_me says whether the
  person is SW Admin, and only they see Settings.
*/
create or replace function public.qt_me() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case
    when current_employee_id() is null then null
    when exists (select 1 from qt_people where employee_id = current_employee_id())
      then (select jsonb_build_object('id', p.employee_id, 'name', (select full_name from employees where id = p.employee_id),
              'role', p.role, 'observes', p.observes, 'lead', p.is_lead or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
              'admin', coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
              'team_lead_id', p.team_lead_id, 'team_lead_name', (select full_name from employees where id = p.team_lead_id))
            from qt_people p where p.employee_id = current_employee_id())
    when coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
      then jsonb_build_object('id', current_employee_id(), 'role', 'viewer', 'lead', true, 'admin', true)
  end
$$;

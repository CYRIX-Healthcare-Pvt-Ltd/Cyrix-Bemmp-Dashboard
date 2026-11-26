/*
  0061: who gives tracker roles (the user, 16 Nov: "only sw admin need that access, move to sw admin"; "dont need
  setting for other user in tracker"; "only lead can add new engineer under him, ie only his reportees newly joined").
  SW Admin gives and takes every role, Quotation maker among them, in SW Admin → BEMMP. In the tracker, a Team Lead may
  only add their own reportees, not yet in the tracker, as Engineers under themselves. Nobody else changes people there.
*/
do $$
declare f text;
  a1 text := $q$if not qt_is_lead() then raise exception 'Only a lead can change people.'; end if;$q$;
  b1 text := $q$if not coalesce(public.is_sw_admin(), false) then
    if coalesce(qt_role(), '') <> 'team_lead' or coalesce(p->>'role', '') <> 'engineer' then
      raise exception 'Only SW Admin can change people.';
    end if;
    if not exists (select 1 from employees x where upper(x.ecode) = upper(btrim(p->>'ecode')) and x.is_active
                   and x.reporting_manager_id = current_employee_id()) then
      raise exception 'Only your own reportees can be added.';
    end if;
    if exists (select 1 from qt_people q join employees x on x.id = q.employee_id where upper(x.ecode) = upper(btrim(p->>'ecode'))) then
      raise exception '% is already in the tracker.', upper(btrim(p->>'ecode'));
    end if;
    p := p || jsonb_build_object('team_lead_ecode', (select ecode from employees where id = current_employee_id()), 'lead', false, 'observes', null);
  end if;$q$;
  b2 text := $q$if not coalesce(public.is_sw_admin(), false) then raise exception 'Only SW Admin can change people.'; end if;$q$;
begin
  f := pg_get_functiondef('public.qt_save_person(jsonb)'::regprocedure);
  if position(a1 in f) = 0 then raise exception 'qt_save_person changed'; end if;
  execute replace(f, a1, b1);
  f := pg_get_functiondef('public.qt_remove_person(uuid)'::regprocedure);
  if position(a1 in f) = 0 then raise exception 'qt_remove_person changed'; end if;
  execute replace(f, a1, b2);
end $$;

-- A Team Lead's reportees: the ones in the tracker under them, and the ones not in it yet, to add.
create or replace function public.qt_my_reportees() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('ecode', e.ecode, 'name', e.full_name, 'designation', e.designation,
      'role', q.role, 'in', q.employee_id is not null, 'mine', q.team_lead_id = current_employee_id())
      order by (q.employee_id is not null), e.full_name), '[]'::jsonb)
  from employees e left join qt_people q on q.employee_id = e.id
  where e.reporting_manager_id = current_employee_id() and e.is_active
    and coalesce(qt_role(), '') = 'team_lead'
$$;
revoke all on function public.qt_my_reportees() from public, anon;
grant execute on function public.qt_my_reportees() to authenticated;

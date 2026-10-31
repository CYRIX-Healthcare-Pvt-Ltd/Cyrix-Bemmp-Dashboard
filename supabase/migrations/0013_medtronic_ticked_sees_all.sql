-- =====================================================================
-- BEMMP · 0013 · Medtronic ticked for somebody outside its reporting line
--
-- 0012 showed Medtronic only to its managers, their engineers and the
-- managers' managers. Ticked in SW Admin for anyone else (the user ticked
-- himself, 31 Oct), it showed nothing at all. Ticked like a contract, it
-- now works like one left on Everything: every work order, to look at.
-- The reporting line still decides for those on it; E78 keeps seeing
-- his own managers' teams.
-- =====================================================================

create or replace function public.mt_sees_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
    or (current_employee_id() is not null
        and not exists (select 1 from mt_managers k where k.employee_id = current_employee_id())
        and not exists (select 1 from mt_managers k join employees e on e.id = k.employee_id
                        where e.reporting_manager_id = current_employee_id())
        and not exists (select 1 from employees e join mt_managers k on k.employee_id = e.reporting_manager_id
                        where e.id = current_employee_id()));
$$;

create or replace function public.mt_sees(p_manager uuid, p_engineer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select in_scope('mt') and (
    p_manager = current_employee_id()
    or p_engineer = current_employee_id()
    or exists (select 1 from employees m where m.id = p_manager and m.reporting_manager_id = current_employee_id())
    or mt_sees_all()
  );
$$;

create or replace function public.mt_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when current_employee_id() is null or not in_scope('mt') then null else jsonb_build_object(
    'manager', exists (select 1 from mt_managers k where k.employee_id = current_employee_id()),
    'viewer', exists (select 1 from mt_managers k join employees e on e.id = k.employee_id
                      where e.reporting_manager_id = current_employee_id()),
    'engineer', exists (select 1 from employees e join mt_managers k on k.employee_id = e.reporting_manager_id
                        where e.id = current_employee_id()),
    'admin', coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
    'all', mt_sees_all()
  ) end;
$$;

revoke all on function public.mt_sees_all() from public, anon;
grant execute on function public.mt_sees_all() to authenticated;

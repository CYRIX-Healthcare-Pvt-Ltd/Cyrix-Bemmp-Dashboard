/*
 * The user, 12 Nov ("send"): everybody in the Quotation tracker is told it has moved here from the
 * old tracker (test accounts left out), and from now on a person given 'qt' hears of it like the
 * contracts ("New in BEMMP: Quotation tracker"), as the notice was held only until the tracker was tested.
 */
create or replace function public.bemmp_project_notify() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare e uuid; p text; nm text;
begin
  select id into e from employees where auth_user_id = new.id and is_active;
  if e is null or not exists (select 1 from employee_modules where employee_id = e and module_code = 'bemmp') then
    return null;
  end if;
  for p in select unnest(new.scope) except select unnest(coalesce(old.scope, '{}'::text[])) loop
    nm := case p when 'kl' then 'Kerala' when 'ap' then 'Andhra Pradesh'
                 when 'up' then 'Uttar Pradesh' when 'mt' then 'Medtronic' when 'pm' then 'PM checklist'
                 when 'qt' then 'Quotation tracker' end;
    continue when nm is null;
    perform push_queue_module(e,
      'New in BEMMP: ' || nm,
      nm || ' is now assigned to you in BEMMP. Open it from the Cyrix portal.',
      '/bemmp/',
      'bemmp:' || e || ':' || p,
      null);
  end loop;
  return null;
end $$;

select count(*) from (
  select public.push_queue_module(q.employee_id,
    'Quotation tracker has moved',
    'From today, raise and follow spare quotation requests in BEMMP → Quotation tracker on the Cyrix portal. The old tracker is closed.',
    '/bemmp/',
    'qt-moved:' || q.employee_id,
    null)
  from qt_people q join employees e on e.id = q.employee_id
  where e.is_active and not (upper(e.ecode) in ('E6666', 'E7777', 'E8888', 'E9999') or e.full_name ilike '%- test%')
) s;

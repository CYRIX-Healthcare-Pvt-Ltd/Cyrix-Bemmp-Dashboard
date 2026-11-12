/*
 * Anyone given a Quotation tracker role has the BEMMP module on the portal, automatically
 * (the user, 12 Nov: "those who have quotation, automatically bemmp module should be enabled").
 * granted_by stays null, so this adds no "New module" notice of its own; the BEMMP notice for
 * the tracker says what is new. Taking the tracker role away leaves BEMMP as it is (contracts).
 */
create or replace function public.qt_people_bemmp() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  insert into employee_modules (employee_id, module_code) values (new.employee_id, 'bemmp') on conflict do nothing;
  return null;
exception when others then
  return null;  -- never block saving a person
end $$;
revoke execute on function public.qt_people_bemmp() from public, anon, authenticated;
drop trigger if exists qt_people_bemmp on public.qt_people;
create trigger qt_people_bemmp after insert or update of employee_id on public.qt_people
  for each row execute function public.qt_people_bemmp();

-- Everybody in the tracker today.
insert into employee_modules (employee_id, module_code)
select q.employee_id, 'bemmp' from qt_people q join employees e on e.id = q.employee_id and e.is_active
on conflict do nothing;

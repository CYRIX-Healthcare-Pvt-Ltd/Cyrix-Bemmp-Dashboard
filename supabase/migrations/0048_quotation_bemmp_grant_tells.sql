/*
 * The user, 12 Nov: "whenever we add module or submodule notification will go". The tracker's own
 * BEMMP grant (0046) is silent, and the 'qt' notice (0047) only fires for someone who already had
 * BEMMP when 'qt' was ticked; so a person new to BEMMP heard nothing. When the tracker role is what
 * turns BEMMP on, that person now gets "New in BEMMP: Quotation tracker" (same key as 0047's, so never twice a day).
 */
create or replace function public.qt_people_bemmp() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare added int;
begin
  insert into employee_modules (employee_id, module_code) values (new.employee_id, 'bemmp') on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 and not (select upper(ecode) in ('E6666', 'E7777', 'E8888', 'E9999') or full_name ilike '%- test%' from employees where id = new.employee_id) then
    perform push_queue_module(new.employee_id,
      'New in BEMMP: Quotation tracker',
      'Quotation tracker is now assigned to you in BEMMP. Open it from the Cyrix portal.',
      '/bemmp/',
      'bemmp:' || new.employee_id || ':qt',
      null);
  end if;
  return null;
exception when others then
  return null;  -- never block saving a person
end $$;

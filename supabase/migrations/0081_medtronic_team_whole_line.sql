-- =====================================================================
-- BEMMP · 0081 · Medtronic: the manager's team is the whole line below him
--
-- The user, 23 Nov 2026: "jestin should able to assign ticket [to] his branch
-- team members [who] may be under jayasurya also". Jestin (E1266) had only his
-- direct reportees; Alageshwaran K and Sathish Kumar J report to Jeyasurya M,
-- who reports to Jestin. Assigning (the window and the TM's "Assign to"
-- column) and the team list on the dashboard now take everyone below the
-- manager, at any depth.
-- =====================================================================

-- Is p_emp anywhere below p_mgr? (Stops after 12 levels, so a loop in the data cannot run away.)
create or replace function public.mt_in_line(p_emp uuid, p_mgr uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with recursive up as (
    select reporting_manager_id as mgr, 1 as depth from employees where id = p_emp
    union all
    select e.reporting_manager_id, up.depth + 1 from employees e join up on e.id = up.mgr
     where up.depth < 12 and up.mgr is not null
  )
  select p_emp is not null and p_mgr is not null and p_emp <> p_mgr
     and exists (select 1 from up where mgr = p_mgr);
$$;
revoke all on function public.mt_in_line(uuid, uuid) from public, anon;
grant execute on function public.mt_in_line(uuid, uuid) to authenticated;

do $$
declare f text; g text;
begin
  -- Assign window.
  f := pg_get_functiondef('public.mt_assign(uuid[], uuid)'::regprocedure);
  g := replace(f, 'where id = p_engineer and reporting_manager_id = me and is_active',
                  'where id = p_engineer and mt_in_line(id, me) and is_active');
  if g = f then raise exception 'mt_assign is not as expected; nothing changed'; end if;
  execute g;

  -- The TM's "Assign to" column (both places it looks the engineer up).
  f := pg_get_functiondef('public.mt_upload(jsonb, text)'::regprocedure);
  g := replace(f, 'e.reporting_manager_id = me and e.is_active', 'mt_in_line(e.id, me) and e.is_active');
  if g = f or position('reporting_manager_id = me and e.is_active' in g) > 0 then
    raise exception 'mt_upload is not as expected; nothing changed';
  end if;
  execute g;

  -- The team the window offers and the TAT table lists.
  f := pg_get_functiondef('public.mt_data()'::regprocedure);
  g := replace(f, 'where e.reporting_manager_id = current_employee_id() and e.is_active',
                  'where mt_in_line(e.id, current_employee_id()) and e.is_active');
  if g = f then raise exception 'mt_data is not as expected; nothing changed'; end if;
  execute g;
end $$;

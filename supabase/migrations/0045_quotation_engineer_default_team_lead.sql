/*
 * An engineer's Team Lead defaults to the engineer's reporting manager when that manager is a
 * Quotation tracker Team Lead (the user, 12 Nov: "it should automatically ... not manual selection").
 * A Team Lead chosen by hand still wins; with neither, the server still asks for one.
 */
create or replace function public.qt_save_person(p jsonb) returns void
language plpgsql security definer set search_path to 'public' as $$
declare who uuid; tl uuid; obs text := nullif(p->>'observes', '');
begin
  if not qt_is_lead() then raise exception 'Only a lead can change people.'; end if;
  select id into who from employees where upper(ecode) = upper(btrim(p->>'ecode')) and is_active;
  if who is null then raise exception 'No active employee %.', p->>'ecode'; end if;
  if coalesce(p->>'role', '') not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer') then raise exception 'Choose the role.'; end if;
  if p->>'role' = 'engineer' then
    if nullif(btrim(coalesce(p->>'team_lead_ecode', '')), '') is not null then
      select id into tl from employees where upper(ecode) = upper(btrim(p->>'team_lead_ecode'));
    else
      select e.reporting_manager_id into tl from employees e where e.id = who;
    end if;
    if tl is null or not exists (select 1 from qt_people where employee_id = tl and role = 'team_lead') then raise exception 'Choose the Team Lead.'; end if;
  end if;
  if p->>'role' <> 'observer' then obs := null; end if;
  if obs is not null and obs not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv') then raise exception 'Choose the team observed.'; end if;
  insert into qt_people (employee_id, role, is_lead, team_lead_id, added_by, observes)
  values (who, p->>'role', coalesce((p->>'lead')::boolean, false), tl, current_employee_id(), obs)
  on conflict (employee_id) do update set role = excluded.role, is_lead = excluded.is_lead, team_lead_id = excluded.team_lead_id, observes = excluded.observes;
end $$;

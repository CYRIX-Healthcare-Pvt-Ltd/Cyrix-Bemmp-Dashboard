-- =====================================================================
-- BEMMP · 0082 · Medtronic: an engineer with reportees leads them
--
-- The user, 23 Nov 2026, about Jeyasurya M (E401), who reports to Jestin and
-- has two Chennai engineers below him: "he can also assign to reassign to his
-- resp reportees". And the gap 0081 left: Medtronic counted someone as an
-- engineer only when he reported straight to a Medtronic manager, so
-- Alageshwaran K and Sathish Kumar J could not open their tickets at all.
--
-- - Engineer: anyone in the line below a Medtronic manager, at any depth.
-- - Lead: an engineer with active people below him. He sees their tickets,
--   and reassigns a ticket that is with him or his line to himself or his
--   line. He never takes a ticket off everybody, and the ticket stays the
--   Medtronic manager's.
-- =====================================================================

-- The people below p_mgr, at any depth (12 levels at most).
create or replace function public.mt_line_ids(p_mgr uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  with recursive down as (
    select id, 1 as depth from employees where reporting_manager_id = p_mgr and is_active
    union all
    select e.id, d.depth + 1 from employees e join down d on e.reporting_manager_id = d.id
     where d.depth < 12 and e.is_active
  )
  select coalesce(array_agg(distinct id), '{}') from down where id <> p_mgr;
$$;
revoke all on function public.mt_line_ids(uuid) from public, anon;
grant execute on function public.mt_line_ids(uuid) to authenticated;

-- ------------------------------------------------------------------ who --
create or replace function public.mt_me() returns jsonb
language sql stable security definer set search_path = public as $$
  with x as (
    select current_employee_id() as me,
           exists (select 1 from mt_managers k where k.employee_id = current_employee_id()) as mgr,
           exists (select 1 from mt_managers k where mt_in_line(current_employee_id(), k.employee_id)) as eng
  )
  select case when x.me is null or not in_scope('mt') then null else jsonb_build_object(
    'manager', x.mgr,
    'viewer', exists (select 1 from mt_managers k join employees e on e.id = k.employee_id
                      where e.reporting_manager_id = x.me),
    'engineer', x.eng,
    'lead', x.eng and not x.mgr and exists (select 1 from employees e where e.reporting_manager_id = x.me and e.is_active),
    'admin', coalesce((select role::text = 'admin' from profile where id = auth.uid()), false),
    'all', mt_sees_all()
  ) end
  from x;
$$;

-- ---------------------------------------------------------------- sees --
create or replace function public.mt_sees(p_manager uuid, p_engineer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select in_scope('mt') and (
    p_manager = current_employee_id()
    or p_engineer = current_employee_id()
    or exists (select 1 from employees m where m.id = p_manager and m.reporting_manager_id = current_employee_id())
    or mt_in_line(p_engineer, current_employee_id())
    or mt_sees_all()
  );
$$;

-- ---------------------------------------------------------------- data --
do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.mt_data()'::regprocedure);
  -- The line below me, read once.
  g := replace(f, 'select current_employee_id() as me, in_scope(''mt'') as scope, mt_sees_all() as all_',
                  'select current_employee_id() as me, in_scope(''mt'') as scope, mt_sees_all() as all_,
           mt_line_ids(current_employee_id()) as line,
           exists (select 1 from mt_managers k where k.employee_id = current_employee_id()) as mgr,
           exists (select 1 from mt_managers k where mt_in_line(current_employee_id(), k.employee_id)) as eng');
  -- A lead sees the tickets of the people below him.
  g := replace(g, 'or m.reporting_manager_id = me.me or me.all_)), ''[]''::jsonb),',
                  'or m.reporting_manager_id = me.me or t.engineer_id = any (me.line) or me.all_)), ''[]''::jsonb),');
  -- Team: a manager's whole line; a lead's line and himself (he can take a ticket back).
  g := replace(g, 'from employees e
      where mt_in_line(e.id, current_employee_id()) and e.is_active
        and in_scope(''mt'') and exists (select 1 from mt_managers k where k.employee_id = current_employee_id())), ''[]''::jsonb),',
                  'from employees e cross join me
      where me.scope and e.is_active
        and ((me.mgr and e.id = any (me.line))
          or (me.eng and not me.mgr and cardinality(me.line) > 0 and (e.id = any (me.line) or e.id = me.me)))), ''[]''::jsonb),');
  if g = f or position('t.engineer_id = any (me.line)' in g) = 0 or position('me.mgr and e.id = any (me.line)' in g) = 0
     or position('mt_line_ids(current_employee_id()) as line' in g) = 0 then
    raise exception 'mt_data is not as expected; nothing changed';
  end if;
  execute g;
end $$;

-- -------------------------------------------------------------- assign --
create or replace function public.mt_assign(p_ids uuid[], p_engineer uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  mgr boolean;
  n int;
begin
  if me is null or not in_scope('mt') then raise exception 'Only the Medtronic manager assigns work orders'; end if;
  mgr := exists (select 1 from mt_managers where employee_id = me);
  if not mgr and not exists (select 1 from employees where reporting_manager_id = me and is_active) then
    raise exception 'Only the Medtronic manager assigns work orders';
  end if;
  if p_engineer is null and not mgr then raise exception 'Choose who does it'; end if;
  if p_engineer is not null and not exists (
       select 1 from employees where id = p_engineer and is_active
         and (mt_in_line(id, me) or (not mgr and id = me))) then
    raise exception 'Choose one of your team';
  end if;
  -- A new engineer starts from To accept; the same one keeps where they are.
  with u as (
    update mt_tickets set engineer_id = p_engineer,
                          assigned_at = case when p_engineer is null then null else now() end,
                          assigned_by = me,
                          accepted_at = null, due_on = null, started_at = null, work_status = null, work_status_at = null, spare_secs = 0,
                          status = case when p_engineer is null then status else 'open' end,
                          closed_on = case when p_engineer is null then closed_on else null end,
                          closed_at = case when p_engineer is null then closed_at else null end
      where id = any (p_ids) and closed_by is null and engineer_id is distinct from p_engineer
        and (case when mgr then manager_id = me
                  else engineer_id = me or mt_in_line(engineer_id, me) end)
      returning id)
  insert into mt_events (ticket_id, by, kind, detail)
    select u.id, me, 'assigned', (select ecode from employees where id = p_engineer) from u;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------- sees all --
-- "All" is for people ticked outside the line (0013). An engineer deeper in a
-- manager's line (Alageshwaran, Sathish) was counted as outside it and saw every
-- ticket; he is an engineer and sees his own.
create or replace function public.mt_sees_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
    or (current_employee_id() is not null
        and not exists (select 1 from mt_managers k where k.employee_id = current_employee_id())
        and not exists (select 1 from mt_managers k join employees e on e.id = k.employee_id
                        where e.reporting_manager_id = current_employee_id())
        and not exists (select 1 from mt_managers k where mt_in_line(current_employee_id(), k.employee_id)));
$$;

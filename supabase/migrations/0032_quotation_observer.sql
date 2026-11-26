/*
 * Observer (the user, 11 Nov): sees every request, at every step, and acts on
 * none; no step belongs to it, so it never accepts, is never told, never raises.
 */
alter table public.qt_people drop constraint if exists qt_people_role_check;
alter table public.qt_people add constraint qt_people_role_check
  check (role in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer'));

create or replace function public.qt_save_person(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare who uuid; tl uuid;
begin
  if not qt_is_lead() then raise exception 'Only a lead can change people.'; end if;
  select id into who from employees where upper(ecode) = upper(btrim(p->>'ecode')) and is_active;
  if who is null then raise exception 'No active employee %.', p->>'ecode'; end if;
  if coalesce(p->>'role', '') not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer') then raise exception 'Choose the role.'; end if;
  if p->>'role' = 'engineer' then
    select id into tl from employees where upper(ecode) = upper(btrim(p->>'team_lead_ecode'));
    if tl is null or not exists (select 1 from qt_people where employee_id = tl and role = 'team_lead') then raise exception 'Choose the Team Lead.'; end if;
  end if;
  insert into qt_people (employee_id, role, is_lead, team_lead_id, added_by)
  values (who, p->>'role', coalesce((p->>'lead')::boolean, false), tl, current_employee_id())
  on conflict (employee_id) do update set role = excluded.role, is_lead = excluded.is_lead, team_lead_id = excluded.team_lead_id;
end $$;

create or replace function public.qt_sees(r public.qt_requests) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare me uuid := current_employee_id(); p qt_people; early boolean;
begin
  if me is null then return false; end if;
  if coalesce((select role::text = 'admin' from profile where id = auth.uid()), false) then return true; end if;
  select * into p from qt_people where employee_id = me;
  if not found then return false; end if;
  if r.engineer_id = me or r.raised_by = me or r.team_lead_id = me then return true; end if;
  if p.role = 'observer' then return true; end if;  -- sees every request, acts on none (0032)
  early := r.kind = 'request' and (r.step in ('tl_review', 'eng_fix')
    or (r.step in ('rejected', 'cancelled') and not exists (
      select 1 from qt_events v where v.request_id = r.id
        and v.to_step is not null and v.to_step not in ('tl_review', 'eng_fix', 'rejected', 'cancelled'))));
  if early then return false; end if;
  return p.role in ('coordinator', 'purchase', 'pv') or p.is_lead;
end $$;

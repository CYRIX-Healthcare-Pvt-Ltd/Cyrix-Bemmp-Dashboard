/*
 * An observer of one team sees only the requests that team has touched (the user, 11 Nov): Purchase's observer
 * sees a request once it has reached Purchase (with Purchase now, or a Purchase person acted on it).
 * An observer of every team still sees every request. Nobody else changes.
 */
create or replace function public.qt_sees(r qt_requests) returns boolean
language plpgsql stable security definer set search_path to 'public' as $$
declare me uuid := current_employee_id(); p qt_people; early boolean;
begin
  if me is null then return false; end if;
  if coalesce((select role::text = 'admin' from profile where id = auth.uid()), false) then return true; end if;
  select * into p from qt_people where employee_id = me;
  if not found then return false; end if;
  if r.engineer_id = me or r.raised_by = me or r.team_lead_id = me then return true; end if;
  if p.role = 'observer' then
    return p.observes is null
      or qt_role_of_step(r.step, r.kind) = p.observes
      or exists (select 1 from qt_events v join qt_people q on q.employee_id = v.by
                 where v.request_id = r.id and q.role = p.observes and v.action <> 'note');
  end if;
  early := r.kind = 'request' and (r.step in ('tl_review', 'eng_fix')
    or (r.step in ('rejected', 'cancelled') and not exists (
      select 1 from qt_events v where v.request_id = r.id
        and v.to_step is not null and v.to_step not in ('tl_review', 'eng_fix', 'rejected', 'cancelled'))));
  if early then return false; end if;
  return p.role in ('coordinator', 'purchase', 'pv') or p.is_lead;
end $$;

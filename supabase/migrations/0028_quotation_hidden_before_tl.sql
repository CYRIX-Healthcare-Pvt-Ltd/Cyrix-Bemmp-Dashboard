/*
 * Until the Team Lead approves, a request is the engineer's, the raiser's and
 * that Team Lead's only (the user, 11 Nov): Coordinator, Purchase, PV and
 * other leads do not see it at Team Lead approval, while sent back for fixing,
 * or when rejected or withdrawn before it ever went past the Team Lead.
 */
create or replace function public.qt_sees(r public.qt_requests) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare me uuid := current_employee_id(); p qt_people; early boolean;
begin
  if me is null then return false; end if;
  if coalesce((select role::text = 'admin' from profile where id = auth.uid()), false) then return true; end if;
  select * into p from qt_people where employee_id = me;
  if not found then return false; end if;
  if r.engineer_id = me or r.raised_by = me or r.team_lead_id = me then return true; end if;
  early := r.kind = 'request' and (r.step in ('tl_review', 'eng_fix')
    or (r.step in ('rejected', 'cancelled') and not exists (
      select 1 from qt_events v where v.request_id = r.id
        and v.to_step is not null and v.to_step not in ('tl_review', 'eng_fix', 'rejected', 'cancelled'))));
  if early then return false; end if;
  return p.role in ('coordinator', 'purchase', 'pv') or p.is_lead;
end $$;

/*
 * No second Accept for the same role (the user, 11 Nov): when a step moves to
 * one that the mover's own role does next (Coordinator: SAP rate → Convert to
 * PR → PR), it is accepted by the mover at once, and nobody is told.
 */
create or replace function public.qt_move(p_id uuid, p_action text, p_to text, p_note text, p_done boolean default false)
returns public.qt_requests language plpgsql security definer set search_path = public as $$
declare r qt_requests; me uuid := current_employee_id();
begin
  select * into r from qt_requests where id = p_id for update;
  insert into qt_events (request_id, by, step, action, to_step, note, process_s)
  values (r.id, me, r.step, p_action, p_to, nullif(btrim(coalesce(p_note, '')), ''),
          case when r.accepted_at is not null then qt_secs(r.accepted_at, now()) end);
  update qt_requests set step = p_to, step_since = now(), accepted_by = null, accepted_at = null,
    done = p_done, closed_at = case when p_done then now() end
  where id = p_id returning * into r;
  -- The next step is the mover's own role (Coordinator converts to PR, then raises it): no second Accept (the user, 11 Nov).
  if not p_done and qt_needs_accept(p_to) and qt_role_of_step(p_to, r.kind) =
       (select role from qt_people where employee_id = me) then
    update qt_requests set accepted_by = me, accepted_at = now(),
      coord_id = case when qt_role_of_step(p_to, r.kind) = 'coordinator' and coord_id is null then me else coord_id end,
      purchase_id = case when qt_role_of_step(p_to, r.kind) = 'purchase' and purchase_id is null then me else purchase_id end
    where id = p_id returning * into r;
    insert into qt_events (request_id, by, step, action, accept_s) values (r.id, me, r.step, 'accept', 0);
  end if;
  return r;
end $$;

create or replace function public.qt_tell_next(r public.qt_requests, p_title text)
returns void language plpgsql security definer set search_path = public as $$
declare body text := r.no || ' · ' || r.spare || ' × ' || r.qty || coalesce(' · ' || r.hospital, '');
  want text := qt_role_of_step(r.step, r.kind);
begin
  -- kept by the person who moved it (0029): nobody to tell
  if not r.done and r.accepted_by is not null and r.accepted_by = current_employee_id() then return; end if;
  if r.done then
    perform qt_tell(r.engineer_id, p_title, body, r.id);
  elsif want = 'team_lead' then perform qt_tell(r.team_lead_id, p_title, body, r.id);
  elsif want = 'engineer' then perform qt_tell(r.engineer_id, p_title, body, r.id);
  elsif want = 'coordinator' and r.coord_id is not null then perform qt_tell(r.coord_id, p_title, body, r.id);
  elsif want = 'purchase' and r.purchase_id is not null then perform qt_tell(r.purchase_id, p_title, body, r.id);
  else perform qt_tell_role(want, p_title, body, r.id);
  end if;
  insert into qt_outbox (request_id, to_employee, stage, subject)
  values (r.id, case want when 'team_lead' then r.team_lead_id when 'engineer' then r.engineer_id
                        when 'coordinator' then r.coord_id when 'purchase' then r.purchase_id end,
          r.step, '[' || r.no || '] ' || p_title || ' | ' || r.spare || ' | ' || coalesce(nullif(r.hospital, ''), 'Stock'));
end $$;

revoke execute on function public.qt_move(uuid, text, text, text, boolean), public.qt_tell_next(public.qt_requests, text) from public, anon, authenticated;

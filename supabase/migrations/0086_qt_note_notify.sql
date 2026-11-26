/*
  0086 — A note says whom to notify (the user, 25 Nov: notes are read by everyone on the request, but users want the
  alert like tickets, and not for all): ticked roles, each the request's own person (else everybody of that role),
  never the writer. With no list given it notifies as before (the next step).
*/
drop function if exists public.qt_note(uuid, text);
create or replace function public.qt_note(p_id uuid, p_note text, p_notify text[] default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r     qt_requests;
  me    uuid := current_employee_id();
  role  text;
  who   uuid;
  title text;
  body  text;
begin
  select * into r from qt_requests where id = p_id;
  if not found or not qt_sees(r) then raise exception 'Request not found.'; end if;
  insert into qt_events (request_id, by, step, action, note) values (p_id, me, r.step, 'note', qt_need(p_note, 'note'));
  if p_notify is null then
    if not r.done then perform qt_tell_next(r, 'A note on ' || r.no); end if;
    return;
  end if;
  title := 'A note on ' || r.no || ' from ' || coalesce((select full_name from employees where id = me), 'someone');
  body := left(btrim(p_note), 160);
  foreach role in array p_notify loop
    who := case role when 'engineer' then r.engineer_id when 'team_lead' then r.team_lead_id
             when 'coordinator' then r.coord_id when 'purchase' then r.purchase_id when 'pv' then r.pv_id end;
    if role not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv') then continue; end if;
    if who is not null then
      if who is distinct from me then perform qt_tell(who, title, body, r.id); end if;
    else
      perform qt_tell_role(role, title, body, r.id);
    end if;
  end loop;
end $function$;
grant execute on function public.qt_note(uuid, text, text[]) to authenticated;

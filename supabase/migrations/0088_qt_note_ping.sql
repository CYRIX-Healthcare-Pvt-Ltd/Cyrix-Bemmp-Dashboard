/*
  0088 — A bell beside a note notifies again (the user, 25 Nov: "on click, pop up roles again ... send notification
  again even note is sent"). Same rules as 0086: the request's own person for each ticked role, else everybody of
  that role, never the one pressing. Nothing is added to the timeline.
*/
create or replace function public.qt_note_ping(p_event uuid, p_notify text[])
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  e     qt_events;
  r     qt_requests;
  me    uuid := current_employee_id();
  role  text;
  who   uuid;
  n     integer := 0;
  title text;
begin
  select * into e from qt_events where id = p_event and action = 'note';
  if not found then raise exception 'Note not found.'; end if;
  select * into r from qt_requests where id = e.request_id;
  if not found or not qt_sees(r) then raise exception 'Request not found.'; end if;
  if coalesce(array_length(p_notify, 1), 0) = 0 then raise exception 'Choose whom to notify.'; end if;
  title := 'A note on ' || r.no || ' from ' || coalesce((select full_name from employees where id = e.by), 'someone');
  foreach role in array p_notify loop
    if role not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv') then continue; end if;
    who := case role when 'engineer' then r.engineer_id when 'team_lead' then r.team_lead_id
             when 'coordinator' then r.coord_id when 'purchase' then r.purchase_id when 'pv' then r.pv_id end;
    if who is not null then
      if who is distinct from me then perform qt_tell(who, title, left(e.note, 160), r.id); n := n + 1; end if;
    else
      perform qt_tell_role(role, title, left(e.note, 160), r.id); n := n + 1;
    end if;
  end loop;
  return n;
end $function$;
revoke all on function public.qt_note_ping(uuid, text[]) from public, anon;
grant execute on function public.qt_note_ping(uuid, text[]) to authenticated;

-- Each timeline step carries its id, for the bell.
do $$
declare f text;
begin
  f := pg_get_functiondef('public.qt_one(uuid)'::regprocedure);
  if position($q$jsonb_build_object('at', v.at, 'step', v.step,$q$ in f) = 0 then raise exception 'qt_one changed'; end if;
  execute replace(f, $q$jsonb_build_object('at', v.at, 'step', v.step,$q$, $q$jsonb_build_object('id', v.id, 'at', v.at, 'step', v.step,$q$);
end $$;

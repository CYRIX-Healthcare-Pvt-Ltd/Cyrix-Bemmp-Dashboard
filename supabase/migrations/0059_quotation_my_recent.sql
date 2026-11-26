/*
  0059: each request in the list carries when the viewer last acted on it (my_last_at), for the "My recent changes"
  choice in the tabs after With you (the user, 16 Nov: "amal 1 ticket is in with you, i updated it, so it will move
  to next tab, so it is tough to find it"; "only amal changes to be in his recent changes filter").
*/
do $$
declare f text;
  a1 text := $q$'mine', qt_can_act(r), 'files', qt_files_of(r.id))$q$;
begin
  f := pg_get_functiondef('public.qt_list(date, date)'::regprocedure);
  if position(a1 in f) = 0 then raise exception 'qt_list changed'; end if;
  execute replace(f, a1, $q$'mine', qt_can_act(r), 'files', qt_files_of(r.id),
      'my_last_at', (select max(ev.at) from qt_events ev where ev.request_id = r.id and ev.by = current_employee_id()))$q$);
end $$;

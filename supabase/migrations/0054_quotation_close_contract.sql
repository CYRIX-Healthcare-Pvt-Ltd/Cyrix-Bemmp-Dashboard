/*
  0054: Closing at the Coordinator's first look, a hospital under both CAMC & AMC must say which contract the request
  was under; the request then reads as that one. A hospital with one contract asks nothing (the user, 14 Nov).
*/
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.qt_coord_initial'::regproc);
  n := replace(d,
    'if a = ''close'' then',
    'if a = ''close'' then
    if r.category ilike ''%amc%&%amc%'' then
      if coalesce(p->>''contract'', '''') not in (''AMC'', ''CAMC'') then raise exception ''Choose the contract.''; end if;
      update qt_requests set category = p->>''contract'' where id = p_id;
    end if;');
  if n = d then raise exception 'qt_coord_initial: nothing replaced'; end if;
  execute n;
end $mig$;

/*
  0053: The Coordinator's Close (first look) takes an optional PR no and PR date; the reason stays required
  (the user, 14 Nov: "we need 2 fields, pr number and pr date, not mandatory but remarks mandatory").
*/
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.qt_coord_initial'::regproc);
  n := replace(d,
    'update qt_requests set close_note = btrim(p->>''note'') where id = p_id;',
    'update qt_requests set close_note = btrim(p->>''note''),
      pr_no = coalesce(nullif(btrim(p->>''pr_no''), ''''), pr_no),
      pr_date = coalesce(nullif(p->>''pr_date'', '''')::date, pr_date) where id = p_id;');
  if n = d then raise exception 'qt_coord_initial: nothing replaced'; end if;
  execute n;
end $mig$;

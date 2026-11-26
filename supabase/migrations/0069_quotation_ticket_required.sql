-- =====================================================================
-- BEMMP · 0069 · The ticket ID is required on a spare request
-- The user, 19 Nov: "ticket id mandatory". Not on the Coordinator's stock request.
-- =====================================================================
do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.qt_raise(jsonb)'::regprocedure);
  g := replace(f, $q$perform qt_need(p->>'equipment', 'equipment name');$q$,
    $q$perform qt_need(p->>'ticket', 'ticket ID');
  perform qt_need(p->>'equipment', 'equipment name');$q$);
  if g = f then raise exception 'qt_raise changed'; end if;
  execute g;
end $$;

-- =====================================================================
-- BEMMP · 0070 · Barcode on a spare request
-- The user, 19 Nov: "so we can get barcode also isnt? ie before equipment, in same row".
-- Filled from the Care 360 ticket (serial_no, Care 360's Barcode column), changeable, kept on each request.
-- =====================================================================
alter table qt_requests add column if not exists barcode text;

do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.qt_raise(jsonb)'::regprocedure);
  g := replace(f, $q$update qt_requests set ticket_id = upper(btrim(p->>'ticket')) where id = r.id returning * into r;$q$,
    $q$update qt_requests set ticket_id = upper(btrim(p->>'ticket')), barcode = nullif(btrim(p->>'barcode'), '') where id = r.id returning * into r;$q$);
  if g = f then raise exception 'qt_raise changed'; end if;
  execute g;
end $$;

-- =====================================================================
-- BEMMP · 0068 · A Care 360 ticket ID on a spare request
--
-- The user, 19 Nov: "here the user need ticket id also, so when ticket id
-- is entered automatically all available data should fill", "ya care360
-- needed". The form looks the ticket up (bemp-ticket, Care 360 only) and
-- fills hospital and equipment; the ID is kept on each request raised.
-- =====================================================================

alter table qt_requests add column if not exists ticket_id text;

do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.qt_raise(jsonb)'::regprocedure);
  g := replace(f, 'returning * into r;', 'returning * into r;
    if nullif(btrim(p->>''ticket''), '''') is not null then
      update qt_requests set ticket_id = upper(btrim(p->>''ticket'')) where id = r.id returning * into r;
    end if;');
  if g = f then raise exception 'qt_raise changed'; end if;
  execute g;
end $$;

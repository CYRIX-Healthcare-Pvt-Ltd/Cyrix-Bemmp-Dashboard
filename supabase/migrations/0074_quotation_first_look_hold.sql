-- =====================================================================
-- BEMMP · 0074 · Hold at the Coordinator's first look; remarks required
--
-- The user, 19 Nov: "need Hold button also, and remark mandatory". Hold
-- puts the request on hold and Resume brings it back to the first look
-- (hold_from); every action there needs the remarks.
-- =====================================================================

do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.qt_coord_initial(uuid, jsonb)'::regprocedure);
  g := replace(f, '  if a = ''camc_pr'' then', '  perform qt_need(p->>''note'', ''remarks'');
  if a = ''hold'' then
    update qt_requests set hold_from = ''coord_initial'' where id = p_id;
    r := qt_move(p_id, ''hold'', ''on_hold'', btrim(p->>''note''));
  elsif a = ''camc_pr'' then');
  if g = f then raise exception 'qt_coord_initial changed'; end if;
  execute g;
end $$;

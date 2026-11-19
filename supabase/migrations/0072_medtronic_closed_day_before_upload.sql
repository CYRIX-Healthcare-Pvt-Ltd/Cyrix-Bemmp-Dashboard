-- =====================================================================
-- BEMMP · 0072 · A ticket missing from the TM closes the day before that upload
--
-- The user, 19 Nov: "11th is uploaded date isnt? today uploaded those tickets
-- were not there, so it should show yesterday's date, ie the date of upload
-- -1 of tickets missing". It used to take the last TM that still had it.
-- Tickets closed that way already move to the day before the upload that
-- closed them (closed_at); ones an engineer closed (closed_by) stay.
-- =====================================================================

do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.mt_upload(jsonb, text)'::regprocedure);
  g := replace(f, 'closed_on = t.last_seen, closed_at = now()', 'closed_on = today - 1, closed_at = now()');
  if g = f then raise exception 'mt_upload changed'; end if;
  execute g;
end $$;

update mt_tickets set closed_on = (closed_at at time zone 'Asia/Kolkata')::date - 1
  where status = 'closed' and closed_by is null and closed_at is not null;

/*
  0087 — The Coordinator revises a sent quotation while the customer decides (the user, 25 Nov: "coord can edit and
  send again"). qt_coord_quote also takes a request at eng_quote from a Coordinator: the new quotation replaces the
  current one, the step stays with the engineer (who accepts it again), the engineer and Team Lead are told. Earlier
  quotations stay in its files and timeline.
*/
do $$
declare f text;
begin
  f := pg_get_functiondef('public.qt_coord_quote(uuid,jsonb)'::regprocedure);
  if position($q$  if r.step <> 'coord_quote' then raise exception '% is not waiting for a quotation.', r.no; end if;
  perform qt_check_accepted(r);$q$ in f) = 0
     or position($q$    r := qt_move(p_id, 'quote', 'eng_quote', p->>'note');
    perform qt_tell_next(r, 'Quotation to confirm with the customer');$q$ in f) = 0
  then raise exception 'qt_coord_quote changed'; end if;
  if position($q$declare r qt_requests := qt_get(p_id);$q$ in f) = 0 then raise exception 'qt_coord_quote declare changed'; end if;
  -- qt_get admits only whoever holds the step; a re-send comes from the Coordinator while the engineer holds it.
  f := replace(f, $q$declare r qt_requests := qt_get(p_id);$q$, $q$declare r qt_requests := (select x from qt_requests x where x.id = p_id and (x.step = 'eng_quote' and qt_role() = 'coordinator' and qt_sees(x)));$q$);
  f := replace(f, $q$begin
  if r.step <> 'coord_quote'$q$, $q$begin
  if r.id is null then r := qt_get(p_id); end if;
  if r.step <> 'coord_quote'$q$);
  f := replace(f, $q$  if r.step <> 'coord_quote' then raise exception '% is not waiting for a quotation.', r.no; end if;
  perform qt_check_accepted(r);$q$, $q$  if r.step = 'eng_quote' and a = 'quote' and qt_role() = 'coordinator' then
    null;  -- sent again while the customer decides (0087)
  elsif r.step <> 'coord_quote' then raise exception '% is not waiting for a quotation.', r.no;
  else perform qt_check_accepted(r);
  end if;$q$);
  f := replace(f, $q$    r := qt_move(p_id, 'quote', 'eng_quote', p->>'note');
    perform qt_tell_next(r, 'Quotation to confirm with the customer');$q$, $q$    if r.step = 'eng_quote' then
      r := qt_move(p_id, 'requote', 'eng_quote', p->>'note');
      perform qt_tell(r.engineer_id, 'Revised quotation on ' || r.no, r.no || ' · ' || r.spare || ' × ' || r.qty || coalesce(' · ' || r.hospital, ''), r.id);
      perform qt_tell(r.team_lead_id, 'Revised quotation on ' || r.no, r.no || ' · ' || r.spare || ' × ' || r.qty || coalesce(' · ' || r.hospital, ''), r.id);
      return;
    end if;
    r := qt_move(p_id, 'quote', 'eng_quote', p->>'note');
    perform qt_tell_next(r, 'Quotation to confirm with the customer');$q$);
  execute f;
end $$;

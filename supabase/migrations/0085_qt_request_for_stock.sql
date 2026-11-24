/*
  0085 — An engineer's spare request for stock (the user, 24 Nov: engineers "need stock request also without ticket";
  "same fields as in tickets needed, just a category only"). The same request with the same fields — hospital,
  equipment, photos, spares — and the same way (Team Lead, Coordinator, Purchase, receipt); only the ticket ID is not
  asked, and it is marked for_stock.
*/
alter table public.qt_requests add column if not exists for_stock boolean not null default false;

do $$
declare f text;
begin
  f := pg_get_functiondef('public.qt_raise(jsonb)'::regprocedure);
  if position($q$  perform qt_need(p->>'ticket', 'ticket ID');$q$ in f) = 0
     or position($q$spare, part_no, qty, photos, engineer_note)$q$ in f) = 0
     or position($q$coalesce(array(select jsonb_array_elements_text(s->'photos')), '{}'), nullif(btrim(p->>'note'), ''))$q$ in f) = 0
  then raise exception 'qt_raise changed'; end if;
  f := replace(f, $q$  perform qt_need(p->>'ticket', 'ticket ID');$q$,
    $q$  if not coalesce((p->>'for_stock')::boolean, false) then perform qt_need(p->>'ticket', 'ticket ID'); end if;$q$);
  f := replace(f, $q$spare, part_no, qty, photos, engineer_note)$q$, $q$spare, part_no, qty, photos, engineer_note, for_stock)$q$);
  f := replace(f, $q$coalesce(array(select jsonb_array_elements_text(s->'photos')), '{}'), nullif(btrim(p->>'note'), ''))$q$,
    $q$coalesce(array(select jsonb_array_elements_text(s->'photos')), '{}'), nullif(btrim(p->>'note'), ''), coalesce((p->>'for_stock')::boolean, false))$q$);
  execute f;
end $$;

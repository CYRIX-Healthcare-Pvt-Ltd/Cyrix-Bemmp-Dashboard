-- =====================================================================
-- BEMMP · 0083 · Quotation tracker: Purchase puts a PR on hold itself
--
-- The user, 23 Nov 2026 (QR-193): "when purchase hold, dont come to hold
-- rqst to coord, let pur holds, so now the stage should be till them and they
-- can reopen". At PO & dispatch Purchase now holds with a reason, the request
-- stays with Purchase ("On hold with Purchase"), and Purchase takes it off
-- hold back to PO & dispatch. Asking to cancel still goes to the Coordinator.
-- QR-193, asked of the Coordinator this morning, becomes Purchase's hold.
-- =====================================================================

create or replace function public.qt_role_of_step(p_step text, p_kind text) returns text
language sql immutable set search_path = public as $function$
  select case
    when p_step in ('tl_review', 'tl_clarify') then 'team_lead'
    when p_step in ('coord_initial', 'coord_quote', 'coord_pr', 'coord_decide', 'on_hold') then 'coordinator'
    when p_step in ('purchase_rates', 'purchase_dispatch', 'purchase_faulty', 'purchase_replacement', 'on_hold_dispatch') then 'purchase'
    when p_step = 'pv' then 'pv'
    when p_step in ('receipt', 'observation', 'eng_fix', 'eng_quote') then 'engineer'
    when p_step = 'return_dispatch' then case when p_kind = 'stock' then 'coordinator' else 'engineer' end
  end
$function$;

do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.qt_purchase_dispatch(uuid, jsonb)'::regprocedure);
  g := replace(f, $a$  if a in ('ask_hold', 'ask_cancel') then
    r := qt_move(p_id, a, 'coord_decide', qt_need(p->>'note', 'reason'));$a$,
$b$  -- Hold is Purchase's own (0083); an app still sending ask_hold holds too.
  if a in ('hold', 'ask_hold') then
    r := qt_move(p_id, 'hold', 'on_hold_dispatch', qt_need(p->>'note', 'reason'));
    return;
  end if;
  if a = 'ask_cancel' then
    r := qt_move(p_id, a, 'coord_decide', qt_need(p->>'note', 'reason'));$b$);
  if g = f then raise exception 'qt_purchase_dispatch is not as expected; nothing changed'; end if;
  execute g;
end $$;

-- QR-193: Ananya asked the Coordinator to hold it at 9:58 am; it becomes her hold, kept with Purchase.
do $$
declare r qt_requests; ask qt_events;
begin
  select * into r from qt_requests where no = 'QR-193' and step = 'coord_decide';
  if not found then return; end if;
  select * into ask from qt_events where request_id = r.id and action = 'ask_hold' order by at desc limit 1;
  if not found then return; end if;
  insert into qt_events (request_id, at, by, step, action, to_step, note)
    values (r.id, ask.at + interval '1 second', ask."by", 'coord_decide', 'hold', 'on_hold_dispatch', ask.note);
  update qt_requests set step = 'on_hold_dispatch', step_since = ask.at, accepted_by = null, accepted_at = null
    where id = r.id;
end $$;

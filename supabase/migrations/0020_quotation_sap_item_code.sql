-- Quotation tracker: the SAP rate carries its item code, written before the vendor (the user, 11 Nov 2026).
create or replace function public.qt_coord_initial(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_initial' then raise exception '% is not at the Coordinator''s first look.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'close' then
    r := qt_move(p_id, 'close', 'closed', qt_need(p->>'note', 'reason for closing'), true);
    update qt_requests set close_note = btrim(p->>'note') where id = p_id;
    perform qt_tell_next(r, 'Your spare request was closed by the Coordinator');
  elsif a = 'ask_tl' then
    r := qt_move(p_id, 'ask', 'tl_clarify', qt_need(p->>'note', 'question for the Team Lead'));
    perform qt_tell_next(r, 'The Coordinator asks about a spare request');
  elsif a = 'to_purchase' then
    r := qt_move(p_id, 'to_purchase', 'purchase_rates', p->>'note');
    perform qt_tell_next(r, 'Rates needed');
  elsif a in ('sap_confirm', 'sap_pr') then
    if coalesce((p->>'rate')::numeric, 0) <= 0 then raise exception 'Write the SAP rate.'; end if;
    if p->>'tax' is null or (p->>'tax')::numeric < 0 then raise exception 'Write the tax %% (0 if none).'; end if;
    update qt_requests set sap = true, item_code = qt_need(p->>'item_code', 'item code'),
      orig_vendor = qt_need(p->>'vendor', 'vendor'), orig_rate = (p->>'rate')::numeric,
      orig_tax = (p->>'tax')::numeric where id = p_id;
    if a = 'sap_pr' then
      update qt_requests set picked = 'original' where id = p_id;
      r := qt_move(p_id, 'sap_pr', 'coord_pr', p->>'note');
    else
      r := qt_move(p_id, 'sap_confirm', 'purchase_rates', p->>'note');
      perform qt_tell_next(r, 'SAP rate to confirm');
    end if;
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

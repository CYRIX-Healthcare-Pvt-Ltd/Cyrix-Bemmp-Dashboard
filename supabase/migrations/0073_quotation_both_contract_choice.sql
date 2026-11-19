-- =====================================================================
-- BEMMP · 0073 · A hospital under both CAMC & AMC: the Coordinator picks the contract first
--
-- The user, 19 Nov: "coordinator should select it, then based on that only
-- flow should go". At the Coordinator's first look a "CAMC & AMC" request
-- must say AMC or CAMC whatever is pressed; the request then reads as that
-- one. AMC keeps pricing → quotation → customer approval → PR; CAMC gets
-- "Send to PR" (camc_pr) straight to PR, as a CAMC hospital does (0015, 0067).
-- Replaces 0054's choice at Close only.
-- =====================================================================

create or replace function public.qt_coord_initial(p_id uuid, p jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_initial' then raise exception '% is not at the Coordinator''s first look.', r.no; end if;
  perform qt_check_accepted(r);
  if r.category ilike '%amc%&%amc%' then
    if coalesce(p->>'contract', '') not in ('AMC', 'CAMC') then raise exception 'Choose the contract.'; end if;
    update qt_requests set category = p->>'contract' where id = p_id;
    r := qt_get(p_id);
  end if;
  if a = 'camc_pr' then
    if upper(coalesce(r.category, '')) <> 'CAMC' then raise exception 'Only a CAMC request goes straight to PR.'; end if;
    r := qt_move(p_id, 'approve', 'coord_pr', coalesce(nullif(btrim(p->>'note'), ''), 'CAMC: no pricing, straight to PR'));
  elsif a = 'close' then
    r := qt_move(p_id, 'close', 'closed', qt_need(p->>'note', 'reason for closing'), true);
    update qt_requests set close_note = btrim(p->>'note'),
      pr_no = coalesce(nullif(btrim(p->>'pr_no'), ''), pr_no),
      pr_date = coalesce(nullif(p->>'pr_date', '')::date, pr_date) where id = p_id;
    perform qt_tell_next(r, 'Your spare request was closed by the Coordinator');
  elsif a = 'ask_tl' then
    r := qt_move(p_id, 'ask', 'tl_clarify', qt_need(p->>'note', 'question for the Team Lead'));
    perform qt_tell_next(r, 'The Coordinator asks about a spare request');
  elsif upper(coalesce(r.category, '')) = 'CAMC' then
    raise exception 'A CAMC request needs no pricing: send it to PR.';
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
end $function$;

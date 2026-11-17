/*
  0062 (the user, 17 Nov): two more choices where the Coordinator raises the PR.
  Clarify quote: back to the engineer (no signed copy, say), the reason required; the engineer's reporting manager is told.
  From stock - ITR: the spare taken from the warehouse on an inventory transfer request (ITR no, ITR date, item code,
  approved qty) in place of PR and PO; the request is completed.
*/
alter table public.qt_requests add column if not exists itr_no text, add column if not exists itr_date date;

CREATE OR REPLACE FUNCTION public.qt_coord_pr(p_id uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_pr' then raise exception '% is not waiting for a PR.', r.no; end if;
  perform qt_check_accepted(r);
  -- Straight to PR with both quotes: no PV pick, so the Coordinator picks (compatible by default on screen)
  if a in ('pr', 'quotation') and r.picked is null and nullif(p->>'picked', '') is not null then
    if p->>'picked' not in ('original', 'compatible') then raise exception 'Choose original or compatible.'; end if;
    if (p->>'picked' = 'original' and r.orig_rate is null) or (p->>'picked' = 'compatible' and r.comp_rate is null) then
      raise exception 'There is no % quote to pick.', p->>'picked';
    end if;
    update qt_requests set picked = p->>'picked' where id = p_id;
  end if;
  if a = 'quotation' then
    update qt_requests set quote_submitted = nullif(p->>'quote_submitted', '')::date, quote_approved = nullif(p->>'quote_approved', '')::date,
      coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'quotation', 'quotation_only', p->>'note', true);
    perform qt_tell_next(r, 'Your spare request was closed as quotation only');
  elsif a = 'cancel' then
    r := qt_move(p_id, 'cancel', 'cancelled', qt_need(p->>'note', 'reason for cancelling'), true);
    update qt_requests set close_note = btrim(p->>'note') where id = p_id;
    perform qt_tell_next(r, 'Your spare request was cancelled');
  elsif a = 'hold' then
    update qt_requests set hold_from = 'coord_pr' where id = p_id;
    r := qt_move(p_id, 'hold', 'on_hold', qt_need(p->>'note', 'reason for the hold'));
  elsif a = 'pr' then
    if coalesce(p->>'quote', '') not in ('yes', 'no') then raise exception 'Choose the quotation.'; end if;
    if p->>'quote' = 'yes' then
      if nullif(p->>'quote_submitted', '') is null then raise exception 'Choose the quote submitted on.'; end if;
      if nullif(p->>'quote_approved', '') is null then raise exception 'Choose the quote approved on.'; end if;
      if (p->>'quote_approved')::date < (p->>'quote_submitted')::date then raise exception 'The quote cannot be approved before it was submitted.'; end if;
    else
      p := p - 'quote_submitted' - 'quote_approved';
    end if;
    if coalesce((p->>'approved_qty')::int, 0) < 1 then raise exception 'Write the approved quantity.'; end if;
    if nullif(p->>'pr_date', '') is null then raise exception 'Choose the PR date.'; end if;
    update qt_requests set quote_submitted = nullif(p->>'quote_submitted', '')::date, quote_approved = nullif(p->>'quote_approved', '')::date,
      pr_no = qt_need(p->>'pr_no', 'PR number'), pr_date = (p->>'pr_date')::date, item_code = nullif(btrim(p->>'item_code'), ''),
      approved_qty = (p->>'approved_qty')::int, coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'pr', 'purchase_dispatch', p->>'note');
    perform qt_tell_next(r, 'PR raised, PO and dispatch needed');
  elsif a = 'clarify' then
    -- Clarify quote (0062): back to the engineer, the reason required; their reporting manager told too.
    r := qt_move(p_id, 'clarify', 'eng_quote', qt_need(p->>'note', 'reason'));
    perform qt_tell_next(r, 'Quotation to clarify');
    perform qt_tell((select reporting_manager_id from employees where id = r.engineer_id), 'Quotation to clarify',
      r.no || ' · ' || r.spare || ' · ' || coalesce((select full_name from employees where id = r.engineer_id), '') || ' · ' || btrim(p->>'note'), r.id);
  elsif a = 'itr' then
    -- From stock (0062): taken from the warehouse on an inventory transfer request; the request is completed.
    if coalesce((p->>'approved_qty')::int, 0) < 1 then raise exception 'Write the approved quantity.'; end if;
    if nullif(p->>'itr_date', '') is null then raise exception 'Choose the ITR date.'; end if;
    update qt_requests set itr_no = qt_need(p->>'itr_no', 'ITR number'), itr_date = (p->>'itr_date')::date,
      item_code = qt_need(p->>'item_code', 'item code'), approved_qty = (p->>'approved_qty')::int,
      coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'itr', 'completed', p->>'note', true);
    perform qt_tell_next(r, 'Your spare request was completed from stock');
  else
    raise exception 'Choose what to do.';
  end if;
end $function$;

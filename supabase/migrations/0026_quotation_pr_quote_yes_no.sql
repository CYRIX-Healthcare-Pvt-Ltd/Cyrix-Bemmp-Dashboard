/*
 * Raise PR asks Quotation: Yes / No (the user, 11 Nov). Yes needs both quote
 * dates (approved not before submitted); No saves no dates.
 */
create or replace function public.qt_coord_pr(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
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
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

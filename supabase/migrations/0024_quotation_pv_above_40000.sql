/*
 * PV only above ₹40,000 (the user, 11 Nov): the deciding total is the
 * compatible's with tax when both are quoted, else the one quote's. Above
 * 40,000 the rates must go to PV; at 40,000 or less straight to PR. Stock
 * requests are unchanged (they always go to PR).
 */
create or replace function public.qt_purchase_rates(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r qt_requests := qt_get(p_id); a text := p->>'action';
  q text := case when r.kind = 'stock' then 'compatible' else coalesce(nullif(p->>'quotes', ''), 'both') end;
  has_o boolean; has_c boolean;
begin
  if r.step <> 'purchase_rates' then raise exception '% is not waiting for rates.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'ask' then
    r := qt_move(p_id, 'ask', 'coord_initial', qt_need(p->>'note', 'question for the Coordinator'));
    perform qt_tell_next(r, 'Purchase asks about a request');
    return;
  end if;
  if a = 'approve_sap' then
    if not r.sap or coalesce(r.orig_rate, 0) <= 0 then raise exception 'There is no SAP rate on % to approve.', r.no; end if;
    update qt_requests set picked = 'original', purchase_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'approve_sap', 'coord_pr', p->>'note');
    perform qt_tell_next(r, 'SAP rate approved, PR to raise');
    return;
  end if;
  if a not in ('rates', 'rates_pr') then raise exception 'Choose what to do.'; end if;
  if q not in ('both', 'original', 'compatible') then raise exception 'Choose which quotes there are.'; end if;
  has_o := q in ('both', 'original'); has_c := q in ('both', 'compatible');
  if has_o then
    perform qt_need(p->>'orig_vendor', 'original vendor');
    if coalesce((p->>'orig_rate')::numeric, 0) <= 0 then raise exception 'Write the original rate.'; end if;
    if p->>'orig_tax' is null then raise exception 'Write the original tax %% (0 if none).'; end if;
  end if;
  if has_c then
    perform qt_need(p->>'comp_vendor', 'compatible vendor');
    if coalesce((p->>'comp_rate')::numeric, 0) <= 0 then raise exception 'Write the compatible rate.'; end if;
    if p->>'comp_tax' is null then raise exception 'Write the compatible tax %% (0 if none).'; end if;
  end if;
  if has_o and has_c and (p->>'comp_rate')::numeric * (1 + (p->>'comp_tax')::numeric / 100)
                         >= (p->>'orig_rate')::numeric * (1 + (p->>'orig_tax')::numeric / 100) then
    raise exception 'The compatible rate must be lower than the original.';
  end if;
  if r.kind = 'request' then
    if (case when has_c then (p->>'comp_rate')::numeric * (1 + (p->>'comp_tax')::numeric / 100)
             else (p->>'orig_rate')::numeric * (1 + (p->>'orig_tax')::numeric / 100) end) > 40000 then
      if a = 'rates_pr' then raise exception 'Above ₹40,000 the rates go to PV.'; end if;
    elsif a = 'rates' then raise exception 'At ₹40,000 or less the rates go straight to PR.';
    end if;
  end if;
  update qt_requests set
    orig_vendor = case when has_o then btrim(p->>'orig_vendor') end,
    orig_rate = case when has_o then (p->>'orig_rate')::numeric end,
    orig_tax = case when has_o then (p->>'orig_tax')::numeric end,
    orig_photo = case when has_o then coalesce(nullif(p->>'orig_photo', ''), orig_photo) end,
    comp_vendor = case when has_c then btrim(p->>'comp_vendor') end,
    comp_rate = case when has_c then (p->>'comp_rate')::numeric end,
    comp_tax = case when has_c then (p->>'comp_tax')::numeric end,
    comp_photo = case when has_c then coalesce(nullif(p->>'comp_photo', ''), comp_photo) end,
    warranty = nullif(btrim(p->>'warranty'), ''), lead_days = nullif(p->>'lead_days', '')::int,
    purchase_note = nullif(btrim(p->>'note'), ''), sap = false,
    picked = case when r.kind = 'stock' then 'compatible' when a = 'rates_pr' and q <> 'both' then q end
  where id = p_id;
  if a = 'rates_pr' or r.kind = 'stock' then
    r := qt_move(p_id, 'rates_pr', 'coord_pr', p->>'note');
    perform qt_tell_next(r, 'Rates in, PR to raise');
  else
    r := qt_move(p_id, 'rates', 'pv', p->>'note');
    perform qt_tell_next(r, 'Price verification needed');
  end if;
end $$;

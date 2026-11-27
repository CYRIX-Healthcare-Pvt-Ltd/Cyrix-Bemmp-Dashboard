-- 0093 (the user, 27 Nov):
--  1. "hospital contract changed to camc, so still in ticket it is AMC, why?" — a request keeps the contract it was
--     raised with. Now a change of a hospital's contract also changes its open requests that have not passed the
--     Coordinator's first check (Team Lead approval, a question, Coordinator check, or on hold from those), with a line
--     in each timeline. Later requests keep theirs: their path was already decided by it. QR-231 is put right here.
--  2. "we need ITR option also" / "in camc in this step itr needed" — From stock - ITR at Coordinator checking for
--     CAMC (as at PR, 0062).

CREATE OR REPLACE FUNCTION public.qt_coord_initial(p_id uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_initial' then raise exception '% is not at the Coordinator''s first look.', r.no; end if;
  perform qt_check_accepted(r);
  if r.category ilike '%amc%&%amc%' then
    if coalesce(p->>'contract', '') not in ('AMC', 'CAMC') then raise exception 'Choose the contract.'; end if;
    update qt_requests set category = p->>'contract' where id = p_id;
    r := qt_get(p_id);
  end if;
  if coalesce(p->>'action', '') not in ('to_purchase', 'itr') then perform qt_need(p->>'note', 'remarks'); end if;
  if a = 'hold' then
    update qt_requests set hold_from = 'coord_initial' where id = p_id;
    r := qt_move(p_id, 'hold', 'on_hold', btrim(p->>'note'));
  elsif a = 'camc_pr' then
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
  elsif a = 'itr' then
    -- From stock at the first check of a CAMC request (the user, 27 Nov: "in camc in this step itr needed"; 0093),
    -- the same as at the PR step (0062).
    if upper(coalesce(r.category, '')) <> 'CAMC' then raise exception 'From stock at this step is for a CAMC request.'; end if;
    if coalesce((p->>'approved_qty')::int, 0) < 1 then raise exception 'Write the approved quantity.'; end if;
    if nullif(p->>'itr_date', '') is null then raise exception 'Choose the ITR date.'; end if;
    update qt_requests set itr_no = qt_need(p->>'itr_no', 'ITR number'), itr_date = (p->>'itr_date')::date,
      item_code = qt_need(p->>'item_code', 'item code'), approved_qty = (p->>'approved_qty')::int,
      coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'itr', 'completed', p->>'note', true);
    perform qt_tell_next(r, 'Your spare request was completed from stock');
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

create or replace function public.qt_contract_follows_hospital()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare me uuid := current_employee_id(); x record;
begin
  if new.category is not distinct from old.category then return new; end if;
  for x in
    update qt_requests q set category = new.category
    where q.facility_id = new.id and not q.done
      and (q.step in ('tl_review', 'tl_clarify', 'coord_initial')
           or (q.step = 'on_hold' and q.hold_from in ('tl_review', 'tl_clarify', 'coord_initial')))
      and q.category is distinct from new.category
    returning q.id, q.step
  loop
    insert into qt_events (request_id, by, step, action, note)
    values (x.id, me, x.step, 'contract', coalesce(old.category, '–') || ' → ' || coalesce(new.category, '–'));
  end loop;
  return new;
end $$;
revoke all on function public.qt_contract_follows_hospital() from public, anon, authenticated;

drop trigger if exists trg_qt_contract_follows_hospital on public.qt_facilities;
create trigger trg_qt_contract_follows_hospital after update of category on public.qt_facilities
for each row execute function public.qt_contract_follows_hospital();

-- Requests already behind their hospital's change (QR-231 today).
with fix as (
  update qt_requests q set category = f.category
  from qt_facilities f
  where f.id = q.facility_id and not q.done and q.category is distinct from f.category
    and (q.step in ('tl_review', 'tl_clarify', 'coord_initial')
         or (q.step = 'on_hold' and q.hold_from in ('tl_review', 'tl_clarify', 'coord_initial')))
    and not (f.category ilike '%amc%&%amc%' and upper(q.category) in ('AMC', 'CAMC'))
  returning q.id, q.step, f.category
)
insert into qt_events (request_id, by, step, action, note)
select id, null, step, 'contract', 'Hospital is ' || category from fix;

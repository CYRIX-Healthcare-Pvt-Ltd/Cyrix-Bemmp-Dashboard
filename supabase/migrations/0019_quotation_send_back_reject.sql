-- Quotation tracker: the Team Lead can send a request back to the engineer to correct, or reject it (the user, 11 Nov 2026).
-- eng_fix: with the engineer, no Accept; the engineer corrects and sends it again (back to tl_review) or withdraws it.
-- rejected: done, the engineer hears of it with the reason.

create or replace function public.qt_role_of_step(p_step text, p_kind text) returns text
language sql immutable as $$
  select case
    when p_step in ('tl_review', 'tl_clarify') then 'team_lead'
    when p_step in ('coord_initial', 'coord_pr', 'coord_decide', 'on_hold', 'on_hold_dispatch') then 'coordinator'
    when p_step in ('purchase_rates', 'purchase_dispatch', 'purchase_faulty', 'purchase_replacement') then 'purchase'
    when p_step = 'pv' then 'pv'
    when p_step in ('receipt', 'observation', 'eng_fix') then 'engineer'
    when p_step = 'return_dispatch' then case when p_kind = 'stock' then 'coordinator' else 'engineer' end
  end
$$;

create or replace function public.qt_needs_accept(p_step text) returns boolean
language sql immutable as $$ select p_step not in ('on_hold', 'on_hold_dispatch', 'observation', 'eng_fix') $$;

/* Team Lead: send back (to correct) or reject; a reason either way. p: {action: send_back|reject, note} */
create or replace function public.qt_tl_decline(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action'; why text;
begin
  if r.step <> 'tl_review' then raise exception '% is not waiting for approval.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'send_back' then
    why := qt_need(p->>'note', 'what to correct');
    r := qt_move(r.id, 'send_back', 'eng_fix', why);
    perform qt_tell(r.engineer_id, 'Sent back to you to correct', r.no || ' · ' || why, r.id);
  elsif a = 'reject' then
    why := qt_need(p->>'note', 'reason for rejecting');
    r := qt_move(r.id, 'reject', 'rejected', why, true);
    update qt_requests set close_note = 'Rejected by the Team Lead: ' || why where id = r.id;
    perform qt_tell(r.engineer_id, 'Request rejected', r.no || ' · ' || why, r.id);
  else
    raise exception 'Choose send back or reject.';
  end if;
end $$;

/* Engineer, on a request sent back: correct and send again, or withdraw. p: {action: resend|withdraw, note, equipment.., photos} */
create or replace function public.qt_eng_fix(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'eng_fix' then raise exception '% is not sent back to you.', r.no; end if;
  if a = 'resend' then
    if coalesce((p->>'qty')::int, 0) < 1 then raise exception 'The quantity must be at least 1.'; end if;
    update qt_requests set equipment = qt_need(p->>'equipment', 'equipment name'), make = nullif(btrim(p->>'make'), ''),
      model = nullif(btrim(p->>'model'), ''), serial = nullif(btrim(p->>'serial'), ''),
      spare = qt_need(p->>'spare', 'spare name'), part_no = nullif(btrim(p->>'part_no'), ''), qty = (p->>'qty')::int,
      photos = case when p ? 'photos' then array(select jsonb_array_elements_text(p->'photos')) else photos end
    where id = r.id;
    r := qt_move(r.id, 'resend', 'tl_review', p->>'note');
    perform qt_tell_next(r, 'Corrected request sent again');
  elsif a = 'withdraw' then
    r := qt_move(r.id, 'withdraw', 'cancelled', p->>'note', true);
    perform qt_tell(r.team_lead_id, 'Request withdrawn', r.no || coalesce(' · ' || nullif(btrim(p->>'note'), ''), ''), r.id);
  else
    raise exception 'Choose send again or withdraw.';
  end if;
end $$;

revoke all on function public.qt_tl_decline(uuid, jsonb), public.qt_eng_fix(uuid, jsonb) from public, anon;
grant execute on function public.qt_tl_decline(uuid, jsonb), public.qt_eng_fix(uuid, jsonb) to authenticated;

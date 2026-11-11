/*
 * Quotation before PR (the user, 11 Nov). A hospital request that reaches the
 * Coordinator for PR first waits at coord_quote: the Coordinator attaches the
 * quotation (PDF or photo) with its date, or holds, or cancels. It then goes to
 * the engineer (eng_quote, with an Accept; the Team Lead is told), who says
 * whether the customer approved it, with the signed copy if there is one. Yes
 * opens the PR (coord_pr); No goes back to the Coordinator with the reason.
 * A request completed without a signed copy needs it at the last receipt.
 * Stock requests have no customer, so they go straight to PR as before.
 */
alter table public.qt_requests
  add column if not exists quote_file text,
  add column if not exists quote_date date,
  add column if not exists quote_ok boolean,
  add column if not exists quote_signed text;

create or replace function public.qt_role_of_step(p_step text, p_kind text) returns text
language sql immutable as $$
  select case
    when p_step in ('tl_review', 'tl_clarify') then 'team_lead'
    when p_step in ('coord_initial', 'coord_quote', 'coord_pr', 'coord_decide', 'on_hold', 'on_hold_dispatch') then 'coordinator'
    when p_step in ('purchase_rates', 'purchase_dispatch', 'purchase_faulty', 'purchase_replacement') then 'purchase'
    when p_step = 'pv' then 'pv'
    when p_step in ('receipt', 'observation', 'eng_fix', 'eng_quote') then 'engineer'
    when p_step = 'return_dispatch' then case when p_kind = 'stock' then 'coordinator' else 'engineer' end
  end
$$;

insert into public.qt_stage_targets (step, accept_h, process_h) values ('coord_quote', 4, 24), ('eng_quote', 4, 48)
on conflict (step) do nothing;

/* Every way into PR passes here: a hospital request without the customer's yes waits at the quotation first. */
create or replace function public.qt_move(p_id uuid, p_action text, p_to text, p_note text, p_done boolean default false)
returns public.qt_requests language plpgsql security definer set search_path = public as $$
declare r qt_requests; me uuid := current_employee_id();
begin
  select * into r from qt_requests where id = p_id for update;
  if p_to = 'coord_pr' and r.kind = 'request' and r.quote_ok is not true then p_to := 'coord_quote'; end if;
  insert into qt_events (request_id, by, step, action, to_step, note, process_s)
  values (r.id, me, r.step, p_action, p_to, nullif(btrim(coalesce(p_note, '')), ''),
          case when r.accepted_at is not null then qt_secs(r.accepted_at, now()) end);
  update qt_requests set step = p_to, step_since = now(), accepted_by = null, accepted_at = null,
    done = p_done, closed_at = case when p_done then now() end
  where id = p_id returning * into r;
  -- The next step is the mover's own role (Coordinator converts to PR, then raises it): no second Accept (the user, 11 Nov).
  if not p_done and qt_needs_accept(p_to) and qt_role_of_step(p_to, r.kind) =
       (select role from qt_people where employee_id = me) then
    update qt_requests set accepted_by = me, accepted_at = now(),
      coord_id = case when qt_role_of_step(p_to, r.kind) = 'coordinator' and coord_id is null then me else coord_id end,
      purchase_id = case when qt_role_of_step(p_to, r.kind) = 'purchase' and purchase_id is null then me else purchase_id end
    where id = p_id returning * into r;
    insert into qt_events (request_id, by, step, action, accept_s) values (r.id, me, r.step, 'accept', 0);
  end if;
  return r;
end $$;

/* Coordinator at the quotation. p: {action: quote|hold|cancel, quote_file, quote_date, picked, note} */
create or replace function public.qt_coord_quote(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'coord_quote' then raise exception '% is not waiting for a quotation.', r.no; end if;
  perform qt_check_accepted(r);
  if a = 'quote' then
    if nullif(p->>'quote_file', '') is null then raise exception 'Attach the quotation.'; end if;
    if split_part(p->>'quote_file', '/', 1) <> r.id::text then raise exception 'Attach the quotation again.'; end if;
    if nullif(p->>'quote_date', '') is null then raise exception 'Choose the quotation date.'; end if;
    if (p->>'quote_date')::date > (now() at time zone 'Asia/Kolkata')::date then raise exception 'The quotation date cannot be in the future.'; end if;
    if r.picked is null and nullif(p->>'picked', '') is not null then
      if p->>'picked' not in ('original', 'compatible') then raise exception 'Choose original or compatible.'; end if;
      if (p->>'picked' = 'original' and r.orig_rate is null) or (p->>'picked' = 'compatible' and r.comp_rate is null) then
        raise exception 'There is no % quote to pick.', p->>'picked';
      end if;
      update qt_requests set picked = p->>'picked' where id = p_id;
    end if;
    update qt_requests set quote_file = p->>'quote_file', quote_date = (p->>'quote_date')::date, quote_ok = null,
      coord_note = nullif(btrim(p->>'note'), '') where id = p_id;
    r := qt_move(p_id, 'quote', 'eng_quote', p->>'note');
    perform qt_tell_next(r, 'Quotation to confirm with the customer');
    perform qt_tell(r.team_lead_id, 'Quotation sent to ' || coalesce((select full_name from employees where id = r.engineer_id), 'the engineer'),
                    r.no || ' · ' || r.spare || ' × ' || r.qty || coalesce(' · ' || r.hospital, ''), r.id);
  elsif a = 'cancel' then
    r := qt_move(p_id, 'cancel', 'cancelled', qt_need(p->>'note', 'reason for cancelling'), true);
    update qt_requests set close_note = btrim(p->>'note') where id = p_id;
    perform qt_tell_next(r, 'Your spare request was cancelled');
  elsif a = 'hold' then
    update qt_requests set hold_from = 'coord_quote' where id = p_id;
    r := qt_move(p_id, 'hold', 'on_hold', qt_need(p->>'note', 'reason for the hold'));
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

/* Engineer: did the customer approve the quotation? p: {approved: yes|no, signed, note} */
create or replace function public.qt_eng_quote(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'eng_quote' then raise exception '% is not waiting for the customer''s answer.', r.no; end if;
  perform qt_check_accepted(r);
  if coalesce(p->>'approved', '') = 'yes' then
    if nullif(p->>'signed', '') is not null and split_part(p->>'signed', '/', 1) <> r.id::text then raise exception 'Attach the signed quotation again.'; end if;
    update qt_requests set quote_ok = true, quote_signed = coalesce(nullif(p->>'signed', ''), quote_signed) where id = p_id;
    r := qt_move(p_id, 'quote_yes', 'coord_pr', p->>'note');
    perform qt_tell_next(r, 'Customer approved the quotation, PR to raise');
  elsif p->>'approved' = 'no' then
    update qt_requests set quote_ok = false where id = p_id;
    r := qt_move(p_id, 'quote_no', 'coord_quote', qt_need(p->>'note', 'reason'));
    perform qt_tell_next(r, 'Customer did not approve the quotation');
  else
    raise exception 'Choose whether the customer approved it.';
  end if;
end $$;

/* The last receipt of a hospital request needs the signed quotation if it was not given before (the user, 11 Nov). */
create or replace function public.qt_receipt_signed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.step = 'completed' and old.step is distinct from 'completed' and new.kind = 'request'
     and new.quote_file is not null and new.quote_signed is null then
    raise exception 'Attach the signed quotation.';
  end if;
  return new;
end $$;
drop trigger if exists qt_receipt_signed on public.qt_requests;
create trigger qt_receipt_signed before update of step on public.qt_requests
  for each row execute function public.qt_receipt_signed();

/* Receipt takes the signed copy along: saved first, so the check above sees it. */
create or replace function public.qt_receipt_with_signed(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if nullif(p->>'signed', '') is not null then
    if r.step not in ('receipt', 'observation') then raise exception '% is not waiting for your receipt.', r.no; end if;
    perform qt_check_accepted(r);
    if split_part(p->>'signed', '/', 1) <> r.id::text then raise exception 'Attach the signed quotation again.'; end if;
    update qt_requests set quote_signed = p->>'signed' where id = p_id;
  end if;
  perform qt_receipt(p_id, p);
end $$;

revoke execute on function public.qt_move(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.qt_coord_quote(uuid, jsonb), public.qt_eng_quote(uuid, jsonb), public.qt_receipt_with_signed(uuid, jsonb) from public, anon;
grant execute on function public.qt_coord_quote(uuid, jsonb), public.qt_eng_quote(uuid, jsonb), public.qt_receipt_with_signed(uuid, jsonb) to authenticated;

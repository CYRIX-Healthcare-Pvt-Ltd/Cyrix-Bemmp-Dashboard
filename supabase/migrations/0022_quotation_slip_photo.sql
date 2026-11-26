-- Quotation tracker: a photo of the courier slip with each dispatch, return and replacement (the user, 11 Nov 2026).

alter table public.qt_requests add column if not exists track_photo text, add column if not exists return_track_photo text;

create or replace function public.qt_purchase_dispatch(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); a text := p->>'action';
begin
  if r.step <> 'purchase_dispatch' then raise exception '% is not waiting for dispatch.', r.no; end if;
  perform qt_check_accepted(r);
  if a in ('ask_hold', 'ask_cancel') then
    r := qt_move(p_id, a, 'coord_decide', qt_need(p->>'note', 'reason'));
    perform qt_tell_next(r, case a when 'ask_hold' then 'Purchase asks to hold a PR' else 'Purchase asks to cancel a PR' end);
    return;
  end if;
  update qt_requests set po_no = coalesce(nullif(btrim(p->>'po_no'), ''), po_no), po_date = coalesce(nullif(p->>'po_date', '')::date, po_date),
    vendor = coalesce(nullif(btrim(p->>'vendor'), ''), vendor), item_code = coalesce(nullif(btrim(p->>'item_code'), ''), item_code),
    dispatch_note = coalesce(nullif(btrim(p->>'note'), ''), dispatch_note)
  where id = p_id;
  if a = 'save' then
    insert into qt_events (request_id, by, step, action, note) values (p_id, current_employee_id(), r.step, 'save_po', nullif(btrim(p->>'note'), ''));
  elsif a = 'dispatch' then
    select * into r from qt_requests where id = p_id;
    if r.po_no is null then raise exception 'Write the PO number.'; end if;
    update qt_requests set track_mode = qt_need(p->>'track_mode', 'how it is sent'), track_no = qt_need(p->>'track_no', 'tracking number'),
      track_photo = coalesce(nullif(p->>'photo', ''), track_photo),
      dispatched_at = now() where id = p_id;
    r := qt_move(p_id, 'dispatch', 'receipt', p->>'note');
    perform qt_tell_next(r, 'Your spare is dispatched');
  else
    raise exception 'Choose what to do.';
  end if;
end $$;

create or replace function public.qt_return_dispatch(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'return_dispatch' then raise exception '% is not waiting for a return.', r.no; end if;
  perform qt_check_accepted(r);
  update qt_requests set return_track_mode = qt_need(p->>'track_mode', 'how it is sent'), return_track_no = qt_need(p->>'track_no', 'tracking number'),
    return_track_photo = nullif(p->>'photo', '') where id = p_id;
  r := qt_move(p_id, 'returned', 'purchase_replacement', p->>'note');
  perform qt_tell_next(r, 'Faulty spare sent back');
end $$;

create or replace function public.qt_replacement(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'purchase_replacement' then raise exception '% is not waiting for a replacement.', r.no; end if;
  perform qt_check_accepted(r);
  update qt_requests set track_mode = qt_need(p->>'track_mode', 'how it is sent'), track_no = qt_need(p->>'track_no', 'tracking number'),
    track_photo = coalesce(nullif(p->>'photo', ''), track_photo),
    dispatched_at = now() where id = p_id;
  r := qt_move(p_id, 'replacement', 'receipt', p->>'note');
  perform qt_tell_next(r, 'Your replacement spare is dispatched');
end $$;

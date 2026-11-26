/* Keep under observation means fitted but still watched: received spares are not counted as used until the observation ends (the user, 11 Nov). */
create or replace function public.qt_receipt(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r qt_requests := qt_get(p_id); got int := coalesce((p->>'received')::int, 0); used int := coalesce((p->>'used')::int, 0);
  bad int := coalesce((p->>'faulty')::int, 0); repl boolean; nrec int; nfault int; nused int; nxt text; d date := coalesce(nullif(p->>'date', '')::date, (now() at time zone 'Asia/Kolkata')::date);
begin
  if r.step not in ('receipt', 'observation') then raise exception '% is not waiting for your receipt.', r.no; end if;
  perform qt_check_accepted(r);
  if got < 1 and r.step = 'receipt' then raise exception 'Write how many you received.'; end if;
  if used < 0 or bad < 0 or got < 0 then raise exception 'Quantities cannot be below 0.'; end if;
  -- Under observation: fitted but still watched, so nothing counts as used yet (the user, 11 Nov)
  if r.step = 'receipt' and coalesce((p->>'observe')::boolean, false) then
    used := 0;
    if got - bad < 1 then raise exception 'Nothing is left to keep under observation.'; end if;
  end if;
  -- never more than the PO covers, or the faulty ones being replaced (the user, 11 Nov)
  if r.step = 'receipt' and got > (case when r.faulty_qty > 0 then r.faulty_qty else coalesce(r.approved_qty, r.qty) - r.received_qty end) then
    raise exception 'Received cannot be more than %.', (case when r.faulty_qty > 0 then r.faulty_qty else coalesce(r.approved_qty, r.qty) - r.received_qty end);
  end if;
  if used + bad > got + (case when r.step = 'observation' then r.received_qty - r.used_qty - r.faulty_qty else 0 end) then
    raise exception 'Used and faulty together cannot be more than received.';
  end if;
  if d > (now() at time zone 'Asia/Kolkata')::date then raise exception 'The date cannot be in the future.'; end if;
  if bad > 0 and coalesce(p->>'faulty_kind', '') not in ('Faulty', 'Mismatch') then raise exception 'Choose faulty or mismatch.'; end if;
  repl := r.faulty_qty > 0 and r.step = 'receipt';
  nrec := case when repl then r.received_qty else r.received_qty + got end;
  nfault := case when repl then greatest(0, r.faulty_qty - got) + bad else r.faulty_qty + bad end;
  nused := r.used_qty + used;
  nxt := case when coalesce((p->>'observe')::boolean, false) then 'observation' when nfault > 0 then 'purchase_faulty' else 'completed' end;
  update qt_requests set received_qty = nrec, used_qty = nused, faulty_qty = nfault, received_on = d,
    faulty_kind = case when bad > 0 then p->>'faulty_kind' when nfault = 0 then null else faulty_kind end,
    faulty_note = case when bad > 0 then nullif(btrim(p->>'note'), '') else faulty_note end
  where id = p_id;
  r := qt_move(p_id, case when repl then 'replacement_received' else 'received' end, nxt,
               concat_ws(' · ', got || ' received', case when used > 0 then used || ' used' end, case when coalesce((p->>'observe')::boolean, false) and r.step = 'receipt' then (got - bad) || ' under observation' end, case when bad > 0 then bad || ' ' || lower(p->>'faulty_kind') end, nullif(btrim(p->>'note'), '')),
               nxt = 'completed');
  if nxt = 'purchase_faulty' then perform qt_tell_next(r, coalesce(p->>'faulty_kind', 'Faulty') || ' spare reported'); end if;
end $$;

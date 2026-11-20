/*
 * 0075 · Quotation tracker: the Team Lead can change the photos while approving (the user, 20 Nov: "tl have option to
 * edit or remove and add new image"). p gains photos: [] (the spare's) and equipment_photos: []; each is changed only
 * when sent, equipment_photo stays the first equipment photo. Everything else as live (0015).
 * At raising, one equipment photo and two of each spare are required in the app.
 */
create or replace function public.qt_tl_approve(p_ids uuid[], p jsonb default null) returns int
language plpgsql security definer set search_path = public as $$
declare r qt_requests; i uuid; n int := 0; nxt text;
begin
  foreach i in array p_ids loop
    r := qt_get(i);
    if r.step <> 'tl_review' then raise exception '% is not waiting for approval.', r.no; end if;
    perform qt_check_accepted(r);
    if p is not null and array_length(p_ids, 1) = 1 then
      if coalesce((p->>'qty')::int, 0) < 1 then raise exception 'The quantity must be at least 1.'; end if;
      update qt_requests set equipment = qt_need(p->>'equipment', 'equipment name'), make = nullif(btrim(p->>'make'), ''),
        model = nullif(btrim(p->>'model'), ''), serial = nullif(btrim(p->>'serial'), ''),
        spare = qt_need(p->>'spare', 'spare name'), qty = (p->>'qty')::int where id = r.id;
      if jsonb_typeof(p->'photos') = 'array' then
        update qt_requests set photos = array(select jsonb_array_elements_text(p->'photos')) where id = r.id;
      end if;
      if jsonb_typeof(p->'equipment_photos') = 'array' then
        update qt_requests set equipment_photos = array(select jsonb_array_elements_text(p->'equipment_photos')),
          equipment_photo = p->'equipment_photos'->>0 where id = r.id;
      end if;
    end if;
    nxt := case when upper(coalesce(r.category, '')) = 'CAMC' then 'coord_pr' else 'coord_initial' end;
    r := qt_move(r.id, 'approve', nxt, case when nxt = 'coord_pr' then 'CAMC: no pricing, straight to PR' end);
    perform qt_tell_next(r, 'Spare request approved by the Team Lead');
    n := n + 1;
  end loop;
  return n;
end $$;

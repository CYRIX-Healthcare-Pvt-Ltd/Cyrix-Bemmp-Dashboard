/*
 * 0076 · Quotation tracker: the Team Lead answering a question can change the photos too (the user, 21 Nov, QR-209:
 * "Please share images for required spare" and no way to add them). p gains photos: [] and equipment_photos: [], as in
 * qt_tl_approve (0075); each is changed only when sent. Everything else as live.
 */
create or replace function public.qt_tl_reply(p_id uuid, p jsonb)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare r qt_requests := qt_get(p_id);
begin
  if r.step <> 'tl_clarify' then raise exception '% has no question for you.', r.no; end if;
  perform qt_check_accepted(r);
  if p ? 'spare' then
    if coalesce((p->>'qty')::int, 0) < 1 then raise exception 'The quantity must be at least 1.'; end if;
    update qt_requests set equipment = qt_need(p->>'equipment', 'equipment name'), make = nullif(btrim(p->>'make'), ''),
      model = nullif(btrim(p->>'model'), ''), serial = nullif(btrim(p->>'serial'), ''),
      spare = qt_need(p->>'spare', 'spare name'), qty = (p->>'qty')::int where id = p_id;
  end if;
  if jsonb_typeof(p->'photos') = 'array' then
    update qt_requests set photos = array(select jsonb_array_elements_text(p->'photos')) where id = p_id;
  end if;
  if jsonb_typeof(p->'equipment_photos') = 'array' then
    update qt_requests set equipment_photos = array(select jsonb_array_elements_text(p->'equipment_photos')),
      equipment_photo = p->'equipment_photos'->>0 where id = p_id;
  end if;
  r := qt_move(p_id, 'reply', 'coord_initial', qt_need(p->>'note', 'answer'));
  perform qt_tell_next(r, 'The Team Lead answered');
end $function$;

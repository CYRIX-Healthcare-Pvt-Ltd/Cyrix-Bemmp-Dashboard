/*
 * Equipment photos apart from spare photos (the user, 11 Nov): a request keeps every equipment photo in
 * equipment_photos (equipment_photo stays the first, for the card and older screens); photos holds the spare's only.
 * p gains equipment_photos: [] (the folder is the first spare's id, as before).
 */
alter table public.qt_requests add column if not exists equipment_photos text[] not null default '{}';
update public.qt_requests set equipment_photos = array[equipment_photo] where equipment_photo is not null and equipment_photos = '{}';

create or replace function public.qt_raise(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); pp qt_people; f qt_facilities; s jsonb; r qt_requests; out jsonb := '[]'::jsonb;
begin
  select * into pp from qt_people where employee_id = me;
  if not found or pp.role not in ('engineer', 'team_lead') then raise exception 'Only an engineer or a Team Lead on the quotation tracker can raise a request.'; end if;
  if pp.role = 'engineer' and pp.team_lead_id is null then raise exception 'You have no Team Lead in the quotation tracker yet. Ask the Coordinator Lead to add one.'; end if;
  if nullif(p->>'client_token', '') is not null and exists (select 1 from qt_requests where client_token = p->>'client_token') then
    return (select jsonb_agg(no order by no) from qt_requests where client_token = p->>'client_token');
  end if;
  select * into f from qt_facilities where id = (p->>'facility_id')::uuid;
  if not found then raise exception 'Choose the hospital.'; end if;
  perform qt_need(p->>'equipment', 'equipment name');
  if jsonb_typeof(p->'spares') <> 'array' or jsonb_array_length(p->'spares') = 0 then raise exception 'Add a spare.'; end if;
  for s in select * from jsonb_array_elements(p->'spares') loop
    perform qt_need(s->>'spare', 'spare name');
    if coalesce((s->>'qty')::int, 0) < 1 then raise exception 'The quantity of % must be at least 1.', s->>'spare'; end if;
  end loop;
  for s in select * from jsonb_array_elements(p->'spares') loop
    insert into qt_requests (id, no, kind, step, engineer_id, team_lead_id, raised_by, client_token,
      facility_id, state, district, hospital, category, equipment, make, model, serial, equipment_photo, equipment_photos,
      spare, part_no, qty, photos, engineer_note)
    values (coalesce((s->>'id')::uuid, gen_random_uuid()), qt_next_no('request'), 'request',
      case when pp.role = 'team_lead' then case when f.category = 'CAMC' then 'coord_pr' else 'coord_initial' end else 'tl_review' end,
      me, case when pp.role = 'team_lead' then me else pp.team_lead_id end, me, nullif(p->>'client_token', ''),
      f.id, f.state, f.district, f.name, f.category, btrim(p->>'equipment'), nullif(btrim(p->>'make'), ''), nullif(btrim(p->>'model'), ''),
      nullif(btrim(p->>'serial'), ''), coalesce(nullif(p->>'equipment_photo', ''), p->'equipment_photos'->>0),
      coalesce(array(select jsonb_array_elements_text(p->'equipment_photos')), case when nullif(p->>'equipment_photo', '') is null then '{}' else array[p->>'equipment_photo'] end),
      btrim(s->>'spare'), nullif(btrim(s->>'part_no'), ''), (s->>'qty')::int,
      coalesce(array(select jsonb_array_elements_text(s->'photos')), '{}'), nullif(btrim(p->>'note'), ''))
    returning * into r;
    insert into qt_events (request_id, by, step, action, to_step, note) values (r.id, me, 'raised', 'raise', r.step, r.engineer_note);
    perform qt_tell_next(r, 'New spare request from ' || (select full_name from employees where id = me));
    out := out || to_jsonb(r.no);
  end loop;
  return out;
end $$;

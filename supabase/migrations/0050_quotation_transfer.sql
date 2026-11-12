-- =====================================================================
-- BEMMP · 0050 · Quotation tracker: Transfer (the user, 12 Nov)
--
-- "Namitha is on leave, so from her phone she can transfer to Suhail; Javid to
-- Ananya." On a Coordinator or Purchase step, the person holding it hands it
-- to another of the same role. The new person accepts first; later steps of
-- that role stay with them. History shows "Transferred · Javid → Ananya", the
-- cards "Transferred from Javid" until the step moves on. The new person gets
-- a phone notification and a mail (Cc the one who transferred).
-- =====================================================================

alter table public.qt_requests add column if not exists transferred_from uuid references public.employees(id);
alter table public.qt_events add column if not exists to_person uuid references public.employees(id);
alter table public.qt_mails drop constraint if exists qt_mails_kind_check;
alter table public.qt_mails add constraint qt_mails_kind_check check (kind in ('raised', 'tl_ok', 'quote_ok', 'rates', 'transfer'));

-- The "Transferred from" line belongs to the step it happened on.
create or replace function public.qt_transfer_clears()
returns trigger language plpgsql as $$
begin
  if new.step is distinct from old.step then new.transferred_from := null; end if;
  return new;
end $$;
drop trigger if exists qt_transfer_clears on public.qt_requests;
create trigger qt_transfer_clears before update of step on public.qt_requests
  for each row execute function public.qt_transfer_clears();

create or replace function public.qt_transfer(p_id uuid, p_to uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); r qt_requests; want text; holder uuid; tp qt_people; nm text; body text;
begin
  select * into r from qt_requests where id = p_id for update;
  if not found or r.done then raise exception 'This request is closed.'; end if;
  want := qt_role_of_step(r.step, r.kind);
  if want is null or want not in ('coordinator', 'purchase') then raise exception 'Only a Coordinator or Purchase step can be transferred.'; end if;
  holder := case want when 'coordinator' then r.coord_id else r.purchase_id end;
  if holder is null or holder <> me then raise exception 'Only the person it is with can transfer it.'; end if;
  if p_to is null or p_to = me then raise exception 'Choose who to transfer it to.'; end if;
  select p.* into tp from qt_people p join employees e on e.id = p.employee_id where p.employee_id = p_to and e.is_active;
  if not found or tp.role <> want then
    raise exception 'Choose a % to transfer it to.', case want when 'coordinator' then 'Coordinator' else 'Purchase person' end;
  end if;
  -- Test accounts only on test requests, as Accept pending lists them.
  if qt_is_test(p_to) <> qt_is_test(coalesce(r.engineer_id, r.raised_by)) then
    raise exception 'Choose a % to transfer it to.', case want when 'coordinator' then 'Coordinator' else 'Purchase person' end;
  end if;

  insert into qt_events (request_id, by, step, action, note, to_person, process_s)
  values (r.id, me, r.step, 'transfer', nullif(btrim(coalesce(p_note, '')), ''), p_to,
          case when r.accepted_at is not null then qt_secs(r.accepted_at, now()) end);
  update qt_requests set
    coord_id = case when want = 'coordinator' then p_to else coord_id end,
    purchase_id = case when want = 'purchase' then p_to else purchase_id end,
    accepted_by = null, accepted_at = null, transferred_from = me
  where id = r.id;

  select full_name into nm from employees where id = me;
  body := r.no || ' · ' || r.spare || ' × ' || r.qty || coalesce(' · ' || r.hospital, '');
  perform qt_tell(p_to, 'Transferred to you by ' || coalesce(split_part(nm, ' ', 1), ''), body, r.id);
  return jsonb_build_object('no', r.no, 'to', (select full_name from employees where id = p_to));
end $$;
revoke all on function public.qt_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.qt_transfer(uuid, uuid, text) to authenticated;

-- Lists and the request: who it was transferred from; the history: to whom.
create or replace function public.qt_list(p_from date, p_to date)
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select coalesce(jsonb_agg((to_jsonb(r) - 'client_token') || jsonb_build_object(
      'accepted_by_name', a.full_name, 'engineer_name', e.full_name, 'engineer_code', e.ecode,
      'team_lead_name', t.full_name, 'coord_name', c.full_name, 'purchase_name', pu.full_name, 'pv_name', pv.full_name,
      'transferred_from_name', tf.full_name,
      'mine', qt_can_act(r)) order by r.created_at desc), '[]'::jsonb)
  from qt_requests r
  left join employees e on e.id = r.engineer_id
  left join employees t on t.id = r.team_lead_id
  left join employees c on c.id = r.coord_id
  left join employees pu on pu.id = r.purchase_id
  left join employees pv on pv.id = r.pv_id
  left join employees a on a.id = r.accepted_by
  left join employees tf on tf.id = r.transferred_from
  where qt_sees(r)
    and (not r.done
         or ((p_from is null or (r.created_at at time zone 'Asia/Kolkata')::date >= p_from)
             and (p_to is null or (r.created_at at time zone 'Asia/Kolkata')::date <= p_to)))
$function$;

create or replace function public.qt_one(p_id uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r qt_requests;
begin
  select * into r from qt_requests where id = p_id;
  if not found or not qt_sees(r) then return null; end if;
  return to_jsonb(r) || jsonb_build_object(
    'mine', qt_can_act(r),
    'engineer_name', (select full_name from employees where id = r.engineer_id),
    'engineer_code', (select ecode from employees where id = r.engineer_id),
    'team_lead_name', (select full_name from employees where id = r.team_lead_id),
    'raised_by_name', (select full_name from employees where id = r.raised_by),
    'coord_name', (select full_name from employees where id = r.coord_id),
    'purchase_name', (select full_name from employees where id = r.purchase_id),
    'pv_name', (select full_name from employees where id = r.pv_id),
    'accepted_by_name', (select full_name from employees where id = r.accepted_by),
    'transferred_from_name', (select full_name from employees where id = r.transferred_from),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', v.at, 'step', v.step, 'action', v.action, 'to_step', v.to_step,
                 'note', v.note, 'accept_s', v.accept_s, 'process_s', v.process_s, 'by_name', b.full_name, 'by_code', b.ecode, 'by_role', q.role,
                 'to_name', tn.full_name) order by v.at, v.id)
               from qt_events v left join employees b on b.id = v.by left join qt_people q on q.employee_id = v.by
               left join employees tn on tn.id = v.to_person where v.request_id = r.id), '[]'::jsonb));
end $function$;

-- Mail: a transfer goes To the new person, Cc the one who transferred (qt_mail_claim, qt-mail 'transfer').
create or replace function public.qt_mail_queue()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare k text; m text; r qt_requests; who uuid;
begin
  begin
    m := qt_mail_mode();
    who := new."by";
    k := case when new.action = 'raise' and coalesce(new.to_step, '') <> 'tl_review' then 'raised'
              when new.action = 'approve' and new.step = 'tl_review' then 'tl_ok'
              when new.action = 'quote_yes' then 'quote_ok'
              when new.action in ('rates', 'rates_pr') then 'rates'
              when new.action = 'transfer' then 'transfer' end;
    if k is null or m = 'off' then return new; end if;
    select * into r from qt_requests where id = new.request_id;
    if m = 'test' and not qt_is_test(coalesce(r.engineer_id, who)) then return new; end if;
    insert into qt_mails (kind, request_id, by_id, grp)
    values (k, new.request_id, who, case when k = 'transfer' then new.to_person::text || '|' || coalesce(new.note, '')
                                         else concat_ws('|', r.engineer_id, r.facility_id, lower(r.equipment), r.serial) end);
  exception when others then
    raise warning 'qt_mail_queue: %', sqlerrm;
  end;
  return new;
end $function$;

create or replace function public.qt_mail_claim(p_limit integer default 20)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare out jsonb := '[]'::jsonb; g record; ids bigint[]; reqs jsonb; r1 qt_requests; m text := qt_mail_mode();
  coords text[]; cc text[]; to_id uuid; tnote text;
begin
  for g in
    select q.kind, q.batch, min(q.id) first_id, array_agg(q.id order by q.id) mids, array_agg(q.request_id order by q.id) rids,
           (array_agg(q.by_id order by q.id))[1] by_id, (array_agg(q.grp order by q.id))[1] grp1
    from qt_mails q where q.claimed_at is null
    group by q.kind, q.batch, case when q.kind in ('raised', 'tl_ok') then coalesce(q.grp, '') else q.id::text end
    order by min(q.id) limit p_limit
  loop
    update qt_mails set claimed_at = now() where id = any (g.mids);
    select * into r1 from qt_requests where id = g.rids[1];
    tnote := null;
    if g.kind = 'transfer' then
      to_id := nullif(split_part(coalesce(g.grp1, ''), '|', 1), '')::uuid;
      tnote := nullif(substr(coalesce(g.grp1, ''), length(split_part(coalesce(g.grp1, ''), '|', 1)) + 2), '');
      select array_agg(e.work_email) into coords from employees e where e.id = to_id and e.work_email is not null and (m <> 'test' or qt_is_test(e.id));
      select array_agg(e.work_email) into cc from employees e where e.id = g.by_id and e.work_email is not null and (m <> 'test' or qt_is_test(e.id));
    else
      select array_agg(distinct e.work_email) into coords from qt_people p join employees e on e.id = p.employee_id
        where p.role = 'coordinator' and e.is_active and e.work_email is not null and (qt_is_test(e.id) = (m = 'test'));
      select array_agg(distinct x) into cc from (
        select e.work_email x from employees e where e.id in (r1.engineer_id, r1.team_lead_id, case when g.kind = 'rates' then g.by_id end)
          and e.work_email is not null and (m <> 'test' or qt_is_test(e.id))
      ) s where x is not null and not (x = any (coalesce(coords, '{}')));
    end if;
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'no', r.no, 'spare', r.spare, 'part_no', r.part_no, 'qty', r.qty, 'note', r.engineer_note,
      'orig_vendor', r.orig_vendor, 'orig_rate', r.orig_rate, 'orig_tax', r.orig_tax,
      'comp_vendor', r.comp_vendor, 'comp_rate', r.comp_rate, 'comp_tax', r.comp_tax,
      'warranty', r.warranty, 'lead_days', r.lead_days, 'purchase_note', r.purchase_note, 'picked', r.picked,
      'quote_date', r.quote_date, 'file', coalesce(r.quote_signed, r.quote_file), 'signed', r.quote_signed is not null,
      'step', r.step) order by r.no) into reqs
    from qt_requests r where r.id = any (g.rids);
    out := out || jsonb_build_object(
      'ids', to_jsonb(g.mids), 'kind', g.kind,
      'to', to_jsonb(coalesce(coords, '{}')), 'cc', to_jsonb(coalesce(cc, '{}')),
      'engineer', (select full_name from employees where id = r1.engineer_id),
      'engineer_ecode', (select ecode from employees where id = r1.engineer_id),
      'team_lead', (select full_name from employees where id = r1.team_lead_id),
      'by', (select full_name from employees where id = g.by_id),
      'to_name', case when g.kind = 'transfer' then (select full_name from employees where id = to_id) end,
      'transfer_note', tnote,
      'hospital', r1.hospital, 'district', r1.district, 'category', r1.category,
      'equipment', r1.equipment, 'make', r1.make, 'model', r1.model, 'serial', r1.serial,
      'step', r1.step, 'requests', reqs);
  end loop;
  return out;
end $function$;

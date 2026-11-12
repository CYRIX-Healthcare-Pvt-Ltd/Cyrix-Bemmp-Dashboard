/*
 * The first mail goes when the Team Lead approves, not when the engineer raises (the user, 12 Nov:
 * "mail we need when team lead approves only, when eng raise go to tl so after tl approved").
 * A request a Team Lead raises skips review, so it mails when raised. Approvals of one engineer's
 * spares for one machine at one time go in one mail; a Team Lead approving several engineers at
 * once sends each engineer's own mail.
 */
alter table public.qt_mails drop constraint if exists qt_mails_kind_check;
alter table public.qt_mails add constraint qt_mails_kind_check check (kind in ('raised', 'tl_ok', 'quote_ok', 'rates'));
alter table public.qt_mails add column if not exists grp text;

create or replace function public.qt_mail_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; m text; r qt_requests; who uuid;
begin
  begin
    m := qt_mail_mode();
    who := new."by";
    k := case when new.action = 'raise' and coalesce(new.to_step, '') <> 'tl_review' then 'raised'
              when new.action = 'approve' and new.step = 'tl_review' then 'tl_ok'
              when new.action = 'quote_yes' then 'quote_ok'
              when new.action in ('rates', 'rates_pr') then 'rates' end;
    if k is null or m = 'off' then return new; end if;
    select * into r from qt_requests where id = new.request_id;
    if m = 'test' and not qt_is_test(coalesce(r.engineer_id, who)) then return new; end if;
    insert into qt_mails (kind, request_id, by_id, grp)
    values (k, new.request_id, who, concat_ws('|', r.engineer_id, r.facility_id, lower(r.equipment), r.serial));
  exception when others then
    raise warning 'qt_mail_queue: %', sqlerrm;
  end;
  return new;
end $$;

-- One mail per engineer and machine within one sending.
create or replace function public.qt_mail_claim(p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; g record; ids bigint[]; reqs jsonb; r1 qt_requests; m text := qt_mail_mode();
  coords text[]; cc text[];
begin
  for g in
    select q.kind, q.batch, min(q.id) first_id, array_agg(q.id order by q.id) mids, array_agg(q.request_id order by q.id) rids,
           (array_agg(q.by_id order by q.id))[1] by_id
    from qt_mails q where q.claimed_at is null
    group by q.kind, q.batch, case when q.kind in ('raised', 'tl_ok') then coalesce(q.grp, '') else q.id::text end
    order by min(q.id) limit p_limit
  loop
    update qt_mails set claimed_at = now() where id = any (g.mids);
    select * into r1 from qt_requests where id = g.rids[1];
    select array_agg(distinct e.work_email) into coords from qt_people p join employees e on e.id = p.employee_id
      where p.role = 'coordinator' and e.is_active and e.work_email is not null and (qt_is_test(e.id) = (m = 'test'));
    select array_agg(distinct x) into cc from (
      select e.work_email x from employees e where e.id in (r1.engineer_id, r1.team_lead_id, case when g.kind = 'rates' then g.by_id end)
        and e.work_email is not null and (m <> 'test' or qt_is_test(e.id))
    ) s where x is not null and not (x = any (coalesce(coords, '{}')));
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
      'hospital', r1.hospital, 'district', r1.district, 'category', r1.category,
      'equipment', r1.equipment, 'make', r1.make, 'model', r1.model, 'serial', r1.serial,
      'step', r1.step, 'requests', reqs);
  end loop;
  return out;
end $$;

revoke execute on function public.qt_mail_claim(int) from public, anon, authenticated;

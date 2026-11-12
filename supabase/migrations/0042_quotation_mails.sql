/*
 * Quotation tracker mails (the user, 12 Nov: "we need mail like this from our site also").
 * Three mails, To both Coordinators, Cc the engineer and the engineer's Team Lead (qt_people):
 *   raised    a request raised (the spares raised together go in one mail)
 *   quote_ok  the engineer marks the customer's approval; the signed quotation (else the
 *             Coordinator's quotation file) is attached
 *   rates     Purchase sends the rates; Cc also the Purchase person who sent them
 *             (the user: "when pur replies, the one who send it")
 * Each is queued in qt_mails by a trigger on qt_events and sent by the qt-mail function
 * (KPI supabase/functions/qt-mail) every two minutes.
 * app_settings qt_mail_on: {"mode": "off" | "test" | "on"}. "test" queues only requests raised
 * by the test accounts and mails only test accounts; nothing reaches real people until "on".
 */

create table if not exists public.qt_mails (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('raised', 'quote_ok', 'rates')),
  request_id  uuid not null references public.qt_requests(id) on delete cascade,
  by_id       uuid references public.employees(id) on delete set null,
  batch       bigint not null default txid_current(),
  made_at     timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  error       text
);
create index if not exists qt_mails_waiting on public.qt_mails (made_at) where claimed_at is null;
alter table public.qt_mails enable row level security;
revoke all on public.qt_mails from anon, authenticated;

insert into public.app_settings (key, value) values ('qt_mail_on', '{"mode": "test"}'::jsonb)
on conflict (key) do update set value = '{"mode": "test"}'::jsonb;

create or replace function public.qt_mail_mode() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value->>'mode' from app_settings where key = 'qt_mail_on'), 'off')
$$;

create or replace function public.qt_is_test(p_emp uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select upper(ecode) in ('E6666', 'E7777', 'E8888', 'E9999') or full_name ilike '%- test%' from employees where id = p_emp), false)
$$;

create or replace function public.qt_mail_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; m text := qt_mail_mode(); eng uuid;
begin
  k := case when new.action = 'raise' then 'raised'
            when new.action = 'quote_yes' then 'quote_ok'
            when new.action in ('rates', 'rates_pr') then 'rates' end;
  if k is null or m = 'off' then return new; end if;
  select engineer_id into eng from qt_requests where id = new.request_id;
  if m = 'test' and not qt_is_test(coalesce(eng, new.by)) then return new; end if;
  insert into qt_mails (kind, request_id, by_id) values (k, new.request_id, new.by);
  return new;
end $$;
drop trigger if exists qt_mail_queue on public.qt_events;
create trigger qt_mail_queue after insert on public.qt_events for each row execute function public.qt_mail_queue();

/*
 * Claim up to p_limit mails, grouped: the 'raised' rows of one sending (same transaction and
 * engineer) become one mail. Each comes with its addresses and the requests' details.
 */
create or replace function public.qt_mail_claim(p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; g record; ids bigint[]; reqs jsonb; r1 qt_requests; m text := qt_mail_mode();
  coords text[]; cc text[];
begin
  for g in
    select q.kind, q.batch, min(q.id) first_id, array_agg(q.id order by q.id) mids, array_agg(q.request_id order by q.id) rids,
           (array_agg(q.by_id order by q.id))[1] by_id
    from qt_mails q where q.claimed_at is null
    group by q.kind, q.batch, case when q.kind = 'raised' then null else q.id end
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

create or replace function public.qt_mail_done(p_ids bigint[], p_error text default null) returns void
language sql security definer set search_path = public as $$
  update qt_mails set sent_at = case when p_error is null then now() end, error = p_error where id = any (p_ids)
$$;

revoke execute on function public.qt_mail_mode(), public.qt_is_test(uuid), public.qt_mail_claim(int), public.qt_mail_done(bigint[], text)
  from public, anon, authenticated;

create or replace function public.qt_mail_call() returns bigint
language sql security definer set search_path = public as $$
  select case when exists (select 1 from qt_mails where claimed_at is null) then net.http_post(
    url     := 'https://emuvmihfbnndhbpsndvc.supabase.co/functions/v1/qt-mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-push-key', (select decrypted_secret from vault.decrypted_secrets where name = 'push_reminder_key')),
    body    := '{}'::jsonb, timeout_milliseconds := 120000) end
$$;
revoke execute on function public.qt_mail_call() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'qt-mail';
select cron.schedule('qt-mail', '*/2 * * * *', $$select public.qt_mail_call()$$);

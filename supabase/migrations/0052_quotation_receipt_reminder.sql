/*
 * Engineers who have not confirmed receipt get one bell and phone message every morning at 09:30,
 * listing every request still waiting on them, until each is confirmed (the user, 13 Nov: requests
 * dispatched weeks ago sat unconfirmed; "mail not needed"). Days count from the dispatch date.
 * One request opens that request; several open the tracker.
 */
create or replace function public.qt_receipt_reminders()
returns int language plpgsql security definer set search_path = public as $$
declare e record; mid uuid; n int := 0;
begin
  for e in
    select r.engineer_id,
           count(*) as cnt,
           min(r.id::text) as one_id,
           string_agg(r.no || coalesce(' · ' || ((now() at time zone 'Asia/Kolkata')::date - (r.dispatched_at at time zone 'Asia/Kolkata')::date) || ' days', ''),
                      ', ' order by r.dispatched_at nulls last, r.no) as list
      from qt_requests r
     where r.step = 'receipt' and r.engineer_id is not null
     group by r.engineer_id
  loop
    insert into push_messages (kind, title, body, url, target, sent_by)
    values ('bemmp',
            case when e.cnt = 1 then 'Confirm receipt' else 'Confirm receipt of ' || e.cnt || ' requests' end,
            left(e.list, 400),
            case when e.cnt = 1 then '/bemmp/?q=' || e.one_id else '/bemmp/' end,
            jsonb_build_object('kind', 'bemmp', 'reminder', 'receipt'), null)
    returning id into mid;
    insert into push_inbox (message_id, employee_id) values (mid, e.engineer_id);
    n := n + 1;
  end loop;
  if n > 0 then perform push_call('queued'); end if;
  return n;
end $$;
revoke all on function public.qt_receipt_reminders() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'qt-receipt-reminder';
select cron.schedule('qt-receipt-reminder', '0 4 * * *', $$select public.qt_receipt_reminders()$$);

/*
 * Quotation tracker steps reach phones, not only the bell (the user, 12 Nov: "we need device
 * notifications for all stages, to the stakeholder of that stage"). qt_tell has always queued a
 * 'bemmp' message per step for its person; the push function never sent that kind. KPI's push
 * function now sends 'bemmp' too, the moment a step is saved (this trigger), with the 5-minute
 * round as the backstop. Messages queued before today's switch-on are marked handled, so nobody
 * gets a burst of old ones.
 */
update push_messages set devices = 0, delivered = 0, failed = 0 where kind = 'bemmp' and devices is null;

create or replace function public.push_queued_now()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- now() is this transaction's start, the created_at of anything it queued.
  if exists (select 1 from push_messages where kind in ('module', 'bemmp') and devices is null and created_at = now()) then
    perform push_call('queued');
  end if;
  return null;
end $$;
revoke execute on function public.push_queued_now() from public, anon, authenticated;

drop trigger if exists qt_events_push_now on public.qt_events;
create trigger qt_events_push_now after insert on public.qt_events
  for each statement execute function public.push_queued_now();

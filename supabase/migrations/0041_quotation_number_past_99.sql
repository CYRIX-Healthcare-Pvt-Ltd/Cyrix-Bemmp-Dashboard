/*
 * QR numbers past 99 (the user, 12 Nov: a request at Santhi Hospital Kodakara refused with
 * "duplicate key value violates unique constraint qt_requests_no_key").
 * lpad(n, 2, '0') pads 7 to 07 but also CUTS 166 to 16, and QR-16 was taken. The old sheet's
 * 165 requests came in with their own numbers, so the first new request was the first to go past 99.
 * Pad to two digits only when shorter; longer numbers stay whole: QR-07, QR-99, QR-166.
 */
create or replace function public.qt_next_no(p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare pre text := case p_kind when 'stock' then 'STK' else 'QR' end; n int;
begin
  perform pg_advisory_xact_lock(hashtext('qt_no_' || pre));
  select coalesce(max(substring(no from '^' || pre || '-(\d+)$')::int), 0) + 1 into n
  from qt_requests where no ~ ('^' || pre || '-\d+$');
  return pre || '-' || case when pre = 'QR' and n < 10 then '0' || n::text else n::text end;
end $$;
revoke execute on function public.qt_next_no(text) from public, anon, authenticated;

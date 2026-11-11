/*
 * Request numbers are QR-01, QR-02 … (the user, 11 Nov); stock stays STK-n.
 * ref_no keeps the old software's number (REQ-25 comes in as QR-25, ref REQ-25),
 * shown small under the number and searchable.
 */
alter table public.qt_requests add column if not exists ref_no text;

create or replace function public.qt_next_no(p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare pre text := case p_kind when 'stock' then 'STK' else 'QR' end; n int;
begin
  perform pg_advisory_xact_lock(hashtext('qt_no_' || pre));
  select coalesce(max(substring(no from '^' || pre || '-(\d+)$')::int), 0) + 1 into n
  from qt_requests where no ~ ('^' || pre || '-\d+$');
  return pre || '-' || case when pre = 'QR' then lpad(n::text, 2, '0') else n::text end;
end $$;
revoke execute on function public.qt_next_no(text) from public, anon, authenticated;

-- The requests already here (test ones so far) take the new form.
update public.qt_requests set no = 'QR-' || lpad(substring(no from '^REQ-(\d+)$'), 2, '0')
where no ~ '^REQ-\d+$';

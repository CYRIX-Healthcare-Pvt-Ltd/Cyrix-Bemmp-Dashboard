-- =====================================================================
-- BEMMP · 0084 · Medtronic: their close-by date and our reason when later
--
-- The user, 23 Nov 2026: the TM's Preferred Start Time "is actually eng
-- should close the call on or before this date". On Accept the engineer sees
-- it; an expected closure after it needs a reason, kept on the ticket
-- (due_reason) and in the accept event. A new engineer or a new TM date clears
-- it with the expected closure.
-- =====================================================================

alter table public.mt_tickets add column if not exists due_reason text;

-- "05/11/2026, 11:30 am" (day first, as every TM so far) or "01 Sept 2026, 12:00 pm" → the day.
create or replace function public.mt_by_date(v text) returns date
language plpgsql immutable set search_path = public as $$
declare m text[];
begin
  m := regexp_match(coalesce(v, ''), '^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})');
  if m is not null then return make_date(m[3]::int, m[2]::int, m[1]::int); end if;
  m := regexp_match(coalesce(v, ''), '^\s*(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})');
  if m is not null then return to_date(m[1] || ' ' || m[2] || ' ' || m[3], 'DD Mon YYYY'); end if;
  return null;
exception when others then return null;
end $$;

drop function if exists public.mt_accept(uuid[], date);
create or replace function public.mt_accept(p_ids uuid[], p_due date, p_reason text default null) returns int
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); n int; why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if me is null or not in_scope('mt') then raise exception 'Only the engineer it is assigned to accepts it'; end if;
  if p_due is null then raise exception 'Choose the expected closure date'; end if;
  if p_due < (now() at time zone 'Asia/Kolkata')::date then raise exception 'The expected closure date cannot be before today'; end if;
  if why is null and exists (select 1 from mt_tickets where id = any (p_ids) and mt_by_date(preferred_start) < p_due) then
    raise exception 'Say why it will be after Medtronic''s date';
  end if;
  with u as (
    update mt_tickets set accepted_at = now(), due_on = p_due,
                          due_reason = case when mt_by_date(preferred_start) < p_due then why end
      where id = any (p_ids) and engineer_id = me and accepted_at is null and closed_by is null
      returning id, due_reason)
  insert into mt_events (ticket_id, by, kind, detail)
    select id, me, 'accepted', 'due: ' || p_due || coalesce(' | why: ' || due_reason, '') from u;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to accept: it may be accepted already or given to someone else'; end if;
  return n;
end $$;
revoke all on function public.mt_accept(uuid[], date, text) from public, anon;
grant execute on function public.mt_accept(uuid[], date, text) to authenticated;

-- Wherever the expected closure is cleared, its reason goes with it.
do $$
declare f text; g text; fn text;
begin
  foreach fn in array array['public.mt_assign(uuid[], uuid)', 'public.mt_upload(jsonb, text)'] loop
    f := pg_get_functiondef(fn::regprocedure);
    g := replace(f, 'due_on = null,', 'due_on = null, due_reason = null,');
    if g = f then raise exception '% is not as expected; nothing changed', fn; end if;
    execute g;
  end loop;
end $$;

-- =====================================================================
-- BEMMP · 0079 · Medtronic: the engineer gives an expected closure date on Accept
--
-- The user, 23 Nov 2026: "on accept, they need to add expected closure date,
-- so eng need option to see due column and filter also". The date is required
-- and cannot be before today (IST); it is kept in mt_events too.
-- =====================================================================

alter table public.mt_tickets add column if not exists due_on date;

drop function if exists public.mt_accept(uuid[]);
create or replace function public.mt_accept(p_ids uuid[], p_due date) returns int
language plpgsql security definer set search_path = public as $$
declare me uuid := current_employee_id(); n int;
begin
  if me is null or not in_scope('mt') then raise exception 'Only the engineer it is assigned to accepts it'; end if;
  if p_due is null then raise exception 'Choose the expected closure date'; end if;
  if p_due < (now() at time zone 'Asia/Kolkata')::date then raise exception 'The expected closure date cannot be before today'; end if;
  with u as (
    update mt_tickets set accepted_at = now(), due_on = p_due
      where id = any (p_ids) and engineer_id = me and accepted_at is null and closed_by is null
      returning id)
  insert into mt_events (ticket_id, by, kind, detail) select id, me, 'accepted', 'due: ' || p_due from u;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to accept: it may be accepted already or given to someone else'; end if;
  return n;
end $$;

revoke all on function public.mt_accept(uuid[], date) from public, anon;
grant execute on function public.mt_accept(uuid[], date) to authenticated;

-- A new engineer gives their own date.
do $$
declare f text; g text;
begin
  f := pg_get_functiondef('public.mt_assign(uuid[], uuid)'::regprocedure);
  g := replace(f, 'accepted_at = null, started_at = null,', 'accepted_at = null, due_on = null, started_at = null,');
  if g = f then raise exception 'mt_assign is not as expected; nothing changed'; end if;
  execute g;
  f := pg_get_functiondef('public.mt_upload(jsonb, text)'::regprocedure);
  g := replace(f, 'accepted_at = null, started_at = null,', 'accepted_at = null, due_on = null, started_at = null,');
  if g = f then raise exception 'mt_upload is not as expected; nothing changed'; end if;
  execute g;
end $$;

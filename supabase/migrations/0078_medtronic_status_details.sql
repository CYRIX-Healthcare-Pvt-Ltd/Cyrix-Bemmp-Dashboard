-- =====================================================================
-- BEMMP · 0078 · Medtronic: Observation and Waiting for spare say what
--
-- The user, 23 Nov 2026: "if waiting for spare, new field should enable ie
-- request number (place holder : PI / PO Number), observation also,
-- mandatory". The latest of each is kept on the ticket; every one is in
-- mt_events.detail.
-- =====================================================================

alter table public.mt_tickets
  add column if not exists spare_request text,
  add column if not exists observation   text;

drop function if exists public.mt_set_status(uuid, text);
create or replace function public.mt_set_status(p_id uuid, p_status text, p_detail text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := current_employee_id();
  t mt_tickets;
  d text := nullif(btrim(coalesce(p_detail, '')), '');
begin
  select * into t from mt_tickets where id = p_id for update;
  if not found or me is null or t.engineer_id is distinct from me or not in_scope('mt') then
    raise exception 'Only the engineer it is assigned to updates it';
  end if;
  if t.closed_by is not null then raise exception 'This call is already completed'; end if;
  if t.started_at is null then raise exception 'Start it first'; end if;
  if p_status not in ('started', 'observation', 'waiting_spare', 'waiting_customer', 'under_repair') then
    raise exception 'Choose a status';
  end if;
  if p_status = 'waiting_spare' and d is null then raise exception 'Enter the PI / PO number'; end if;
  if p_status = 'observation' and d is null then raise exception 'Enter the observation'; end if;
  if p_status = t.work_status and p_status not in ('waiting_spare', 'observation') then return; end if;
  update mt_tickets set
      spare_secs = spare_secs + case when t.work_status = 'waiting_spare' and p_status <> 'waiting_spare'
                                     then greatest(0, extract(epoch from now() - t.work_status_at))::int else 0 end,
      work_status_at = case when p_status = t.work_status then work_status_at else now() end,
      work_status = p_status,
      spare_request = case when p_status = 'waiting_spare' then left(d, 100) else spare_request end,
      observation = case when p_status = 'observation' then left(d, 1000) else observation end
    where id = p_id;
  insert into mt_events (ticket_id, by, kind, detail)
    values (p_id, me, 'status', p_status || coalesce(': ' || left(d, 1000), ''));
end $$;

revoke all on function public.mt_set_status(uuid, text, text) from public, anon;
grant execute on function public.mt_set_status(uuid, text, text) to authenticated;

/*
  0060: Quotation makers (the user, 16 Nov: "there are other coordinators, they just create quotations"; Sandhya K Nair
  E2146). A role of its own in the tracker: no requests, no bells, only the Quotations page, where they make the
  company quotation, keep it, edit it and revise it. The QTN number is typed by them for now ("let series they enter
  manually now"). Leads see everybody's.
*/

alter table public.qt_people drop constraint if exists qt_people_role_check;
alter table public.qt_people add constraint qt_people_role_check
  check (role = any (array['engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer', 'maker']));

create table if not exists public.qt_quotes (
  id uuid primary key,
  made_by uuid not null references public.employees(id) on delete restrict,
  qtn_no text not null,
  to_name text,
  total numeric,
  quote_date date,
  doc jsonb not null,
  path text not null,
  sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees(id) on delete set null
);
create index if not exists qt_quotes_by on public.qt_quotes (made_by, created_at desc);
create unique index if not exists qt_quotes_qtn on public.qt_quotes (lower(btrim(qtn_no)));
alter table public.qt_quotes enable row level security;
revoke all on public.qt_quotes from anon, authenticated;

create or replace function public.qt_can_make() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from qt_people where employee_id = current_employee_id() and (role in ('maker', 'coordinator') or is_lead))
      or coalesce((select role::text = 'admin' from profile where id = auth.uid()), false)
$$;

create or replace function public.qt_quotes_list() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'qtn_no', q.qtn_no, 'to', q.to_name, 'total', q.total, 'date', q.quote_date,
      'doc', q.doc, 'path', q.path, 'created_at', q.created_at, 'updated_at', q.updated_at,
      'made_by', q.made_by, 'by_name', e.full_name, 'by_code', e.ecode, 'mine', q.made_by = current_employee_id()) order by q.created_at desc), '[]'::jsonb)
  from qt_quotes q join employees e on e.id = q.made_by
  where q.made_by = current_employee_id() or qt_is_lead()
$$;

create or replace function public.qt_quote_save(p jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare me uuid := current_employee_id(); qid uuid := (p->>'id')::uuid; old qt_quotes; n text := btrim(coalesce(p->>'qtn_no', ''));
begin
  if not qt_can_make() then raise exception 'Only a Quotation maker can save a quotation.'; end if;
  if n = '' then raise exception 'Write the QTN number.'; end if;
  if coalesce(p->>'path', '') = '' or p->'doc' is null then raise exception 'The quotation could not be saved.'; end if;
  if exists (select 1 from qt_quotes where lower(btrim(qtn_no)) = lower(n) and id <> qid)
     or exists (select 1 from qt_quote_files where lower(btrim(qtn_no)) = lower(n)) then
    raise exception 'QTN number % is already used.', n;
  end if;
  select * into old from qt_quotes where id = qid;
  if found then
    if old.made_by <> me and not qt_is_lead() then raise exception 'Only the person who made it can change it.'; end if;
    update qt_quotes set qtn_no = n, to_name = p->>'to', total = (p->>'total')::numeric, quote_date = (p->>'date')::date,
      doc = p->'doc', path = p->>'path', sha256 = p->>'sha256', updated_at = now(), updated_by = me where id = qid;
  else
    insert into qt_quotes (id, made_by, qtn_no, to_name, total, quote_date, doc, path, sha256, updated_by)
    values (qid, me, n, p->>'to', (p->>'total')::numeric, (p->>'date')::date, p->'doc', p->>'path', p->>'sha256', me);
  end if;
  return qid;
end $$;

create or replace function public.qt_quote_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare old qt_quotes;
begin
  select * into old from qt_quotes where id = p_id;
  if not found then return false; end if;
  if old.made_by <> current_employee_id() and not qt_is_lead() then raise exception 'Only the person who made it can delete it.'; end if;
  delete from qt_quotes where id = p_id;
  return true;
end $$;

revoke all on function public.qt_can_make(), public.qt_quotes_list(), public.qt_quote_save(jsonb), public.qt_quote_delete(uuid) from public, anon;
grant execute on function public.qt_can_make(), public.qt_quotes_list(), public.qt_quote_save(jsonb), public.qt_quote_delete(uuid) to authenticated;

-- A made quotation's PDF: its maker and the leads read it (the folder is the quotation's id; one id lookup a file).
create or replace function public.qt_photo_ok(p_name text, p_write boolean)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $function$
declare rid uuid; r qt_requests; mk uuid;
begin
  begin rid := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  select * into r from qt_requests where id = rid;
  if not found then
    select made_by into mk from qt_quotes where id = rid;
    if found then return mk = current_employee_id() or qt_is_lead(); end if;
    return p_write and qt_me() is not null;
  end if;
  return qt_sees(r);
end $function$;

-- Settings can give the role.
do $$
declare f text; a1 text := $q$not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer') then raise exception 'Choose the role.'$q$;
begin
  f := pg_get_functiondef('public.qt_save_person(jsonb)'::regprocedure);
  if position(a1 in f) = 0 then
    if position($q$'observer', 'maker') then raise$q$ in f) > 0 then return; end if;
    raise exception 'qt_save_person changed';
  end if;
  execute replace(f, a1, $q$not in ('engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer', 'maker') then raise exception 'Choose the role.'$q$);
end $$;

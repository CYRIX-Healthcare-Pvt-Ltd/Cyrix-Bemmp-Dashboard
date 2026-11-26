/*
  0057: the Coordinator makes the quotation in the tracker (the user, 16 Nov: they edited it in Excel, pasted it into the
  Word letter, converted it to PDF and attached it; "is there any option that can be done from our end", "they need edit
  before converting and add items also").

  - qt_qtn_series (app_settings 'qt_qtn'): the QTN number series. Test until the user gives the real one:
      {"prefix": "TEST-QTN", "suffix": "/CHC/PVMP", "next": 1}  →  TEST-QTN1/CHC/PVMP/2026-27
    The financial year (April–March, India time) is added at the end, as on the Word letter (QTN405/CHC/PVMP/2026-27).
  - qt_next_qtn(): the next number, for a Coordinator (or a lead / BEMMP admin) only; a number is never given twice.
  - qt_quote_files.doc: what the made quotation says (To, place, date, subject, items, terms), so it can be opened again,
    edited and made as a revision. qt_add_files keeps it; qt_files_of returns it.
*/

insert into public.app_settings (key, value)
values ('qt_qtn', '{"prefix": "TEST-QTN", "suffix": "/CHC/PVMP", "next": 1}'::jsonb)
on conflict (key) do nothing;

create or replace function public.qt_next_qtn()
returns text language plpgsql security definer set search_path to 'public' as $f$
declare s jsonb; n int; d date := (now() at time zone 'Asia/Kolkata')::date; fy int;
begin
  if coalesce(qt_role(), '') <> 'coordinator' and not qt_is_lead() then
    raise exception 'Only a Coordinator can make a quotation.';
  end if;
  select value into s from app_settings where key = 'qt_qtn' for update;
  if s is null then raise exception 'The QTN number series is not set.'; end if;
  n := coalesce((s->>'next')::int, 1);
  update app_settings set value = s || jsonb_build_object('next', n + 1) where key = 'qt_qtn';
  fy := case when extract(month from d) >= 4 then extract(year from d)::int else extract(year from d)::int - 1 end;
  return coalesce(s->>'prefix', 'QTN') || n || coalesce(s->>'suffix', '') || '/' || fy || '-' || lpad(((fy + 1) % 100)::text, 2, '0');
end $f$;
revoke all on function public.qt_next_qtn() from public, anon;
grant execute on function public.qt_next_qtn() to authenticated;

alter table public.qt_quote_files add column if not exists doc jsonb;

create or replace function public.qt_add_files(p_req uuid, p_kind text, p_files jsonb)
returns text language plpgsql security definer set search_path to 'public' as $f$
declare f jsonb; first_path text;
begin
  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    if nullif(f->>'path', '') is null then continue; end if;
    if split_part(f->>'path', '/', 1) <> p_req::text then raise exception 'Attach the file again.'; end if;
    insert into qt_quote_files (request_id, kind, path, sha256, qtn_no, qtn_to, total, created_by, doc)
    values (p_req, p_kind, f->>'path', nullif(f->>'sha256', ''), nullif(btrim(f->>'qtn_no'), ''), nullif(btrim(f->>'qtn_to'), ''),
            case when coalesce(f->>'total', '') ~ '^[0-9]+(\.[0-9]+)?$' then (f->>'total')::numeric end, current_employee_id(),
            case when p_kind = 'quote' and jsonb_typeof(f->'doc') = 'object' then f->'doc' end)
    on conflict (request_id, path) do nothing;
    first_path := coalesce(first_path, f->>'path');
  end loop;
  return first_path;
end $f$;
revoke all on function public.qt_add_files(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.qt_files_of(p_req uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $f$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'path', q.path, 'sha256', q.sha256, 'qtn_no', q.qtn_no,
           'qtn_to', q.qtn_to, 'total', q.total, 'at', q.created_at, 'doc', q.doc) order by q.created_at, q.path), '[]'::jsonb)
  from qt_quote_files q where q.request_id = p_req
$f$;
revoke all on function public.qt_files_of(uuid) from public, anon, authenticated;

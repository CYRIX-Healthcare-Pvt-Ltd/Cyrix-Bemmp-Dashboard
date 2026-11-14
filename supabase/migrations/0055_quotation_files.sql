/*
  0055: Quotations without a limit (the user, 14 Nov: "dont keep quotation upload limit"). Each quotation the
  Coordinator attaches, and each signed copy the engineer brings back, is a row of qt_quote_files with what the app
  read from it: the QTN number, To and the grand total (signed copies: the QTN number), and the file's sha256 so a
  "signed" copy that is the quotation itself shows. quote_file / quote_signed keep the first of each for the mails.
  Read through qt_list / qt_one as 'files'.
*/
create table if not exists public.qt_quote_files (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.qt_requests(id) on delete cascade,
  kind text not null check (kind in ('quote', 'signed')),
  path text not null,
  sha256 text,
  qtn_no text,
  qtn_to text,
  total numeric,
  created_by uuid references public.employees(id),
  created_at timestamptz not null default now(),
  unique (request_id, path)
);
create index if not exists qt_quote_files_req on public.qt_quote_files (request_id);
alter table public.qt_quote_files enable row level security;
revoke all on public.qt_quote_files from anon, authenticated;

/* Files of one kind from p->'files' ([{path, sha256, qtn_no, qtn_to, total}]); each in the request's own folder. */
create or replace function public.qt_add_files(p_req uuid, p_kind text, p_files jsonb)
returns text language plpgsql security definer set search_path to 'public' as $f$
declare f jsonb; first_path text;
begin
  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    if nullif(f->>'path', '') is null then continue; end if;
    if split_part(f->>'path', '/', 1) <> p_req::text then raise exception 'Attach the file again.'; end if;
    insert into qt_quote_files (request_id, kind, path, sha256, qtn_no, qtn_to, total, created_by)
    values (p_req, p_kind, f->>'path', nullif(f->>'sha256', ''), nullif(btrim(f->>'qtn_no'), ''), nullif(btrim(f->>'qtn_to'), ''),
            case when coalesce(f->>'total', '') ~ '^[0-9]+(\.[0-9]+)?$' then (f->>'total')::numeric end, current_employee_id())
    on conflict (request_id, path) do nothing;
    first_path := coalesce(first_path, f->>'path');
  end loop;
  return first_path;
end $f$;
revoke all on function public.qt_add_files(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.qt_files_of(p_req uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $f$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'path', q.path, 'sha256', q.sha256, 'qtn_no', q.qtn_no,
           'qtn_to', q.qtn_to, 'total', q.total, 'at', q.created_at) order by q.created_at, q.path), '[]'::jsonb)
  from qt_quote_files q where q.request_id = p_req
$f$;
revoke all on function public.qt_files_of(uuid) from public, anon, authenticated;

do $mig$
declare d text; n text;
begin
  -- Coordinator: one or many quotations ('files'); the old single quote_file still works.
  d := pg_get_functiondef('public.qt_coord_quote'::regproc);
  n := replace(d,
    'if nullif(p->>''quote_file'', '''') is null then raise exception ''Attach the quotation.''; end if;',
    'if jsonb_array_length(coalesce(p->''files'', ''[]''::jsonb)) > 0 then
      p := p || jsonb_build_object(''quote_file'', qt_add_files(p_id, ''quote'', p->''files''));
    end if;
    if nullif(p->>''quote_file'', '''') is null then raise exception ''Attach the quotation.''; end if;');
  if n = d then raise exception 'qt_coord_quote: nothing replaced'; end if;
  execute n;

  -- Engineer at the customer's answer: signed copies.
  d := pg_get_functiondef('public.qt_eng_quote'::regproc);
  n := replace(d,
    'if nullif(p->>''signed'', '''') is not null and split_part',
    'if jsonb_array_length(coalesce(p->''signed_files'', ''[]''::jsonb)) > 0 then
      p := p || jsonb_build_object(''signed'', qt_add_files(p_id, ''signed'', p->''signed_files''));
    end if;
    if nullif(p->>''signed'', '''') is not null and split_part');
  if n = d then raise exception 'qt_eng_quote: nothing replaced'; end if;
  execute n;

  -- Engineer at the last receipt: signed copies.
  d := pg_get_functiondef('public.qt_receipt_with_signed'::regproc);
  n := replace(d,
    'begin
  if nullif(p->>''signed'', '''') is not null then',
    'begin
  if jsonb_array_length(coalesce(p->''signed_files'', ''[]''::jsonb)) > 0 then
    if r.step not in (''receipt'', ''observation'') then raise exception ''% is not waiting for your receipt.'', r.no; end if;
    perform qt_check_accepted(r);
    p := p || jsonb_build_object(''signed'', qt_add_files(p_id, ''signed'', p->''signed_files''));
  end if;
  if nullif(p->>''signed'', '''') is not null then');
  if n = d then raise exception 'qt_receipt_with_signed: nothing replaced'; end if;
  execute n;

  -- Lists carry the files.
  d := pg_get_functiondef('public.qt_list'::regproc);
  n := replace(d, '''mine'', qt_can_act(r)) order by', '''mine'', qt_can_act(r), ''files'', qt_files_of(r.id)) order by');
  if n = d then raise exception 'qt_list: nothing replaced'; end if;
  execute n;
  d := pg_get_functiondef('public.qt_one'::regproc);
  n := replace(d, '''mine'', qt_can_act(r),', '''mine'', qt_can_act(r), ''files'', qt_files_of(r.id),');
  if n = d then raise exception 'qt_one: nothing replaced'; end if;
  execute n;
end $mig$;

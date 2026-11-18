/*
  0063: Quotation templates (the user, 18 Nov: "quotation template also new tab, so that user can upload their own word
  files which may have different terms, tables etc ... show preview and name it the subject first 2 words, they can edit
  and save ... delete and edit"). A maker's own Word files, in qt-photos under the template's id; leads see everyone's.
*/
create table if not exists public.qt_templates (
  id uuid primary key,
  made_by uuid not null references public.employees(id) on delete restrict,
  name text not null,
  path text not null,
  file_name text,
  size bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists qt_templates_by on public.qt_templates (made_by, created_at desc);
alter table public.qt_templates enable row level security;
revoke all on public.qt_templates from anon, authenticated;

create or replace function public.qt_templates_list() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'path', t.path, 'file_name', t.file_name, 'size', t.size,
      'created_at', t.created_at, 'updated_at', t.updated_at, 'by_name', e.full_name, 'by_code', e.ecode,
      'mine', t.made_by = current_employee_id()) order by t.updated_at desc), '[]'::jsonb)
  from qt_templates t join employees e on e.id = t.made_by
  where t.made_by = current_employee_id() or qt_is_lead()
$$;

create or replace function public.qt_template_save(p jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare me uuid := current_employee_id(); tid uuid := (p->>'id')::uuid; old qt_templates; n text := btrim(coalesce(p->>'name', ''));
begin
  if not qt_can_make() then raise exception 'Only a Quotation maker can save a template.'; end if;
  if n = '' then raise exception 'Write the template name.'; end if;
  if coalesce(p->>'path', '') = '' then raise exception 'Choose the Word file.'; end if;
  if split_part(p->>'path', '/', 1) <> tid::text then raise exception 'Choose the Word file again.'; end if;
  select * into old from qt_templates where id = tid;
  if found then
    if old.made_by <> me and not qt_is_lead() then raise exception 'Only the person who added it can change it.'; end if;
    update qt_templates set name = n, path = p->>'path', file_name = coalesce(p->>'file_name', file_name),
      size = coalesce((p->>'size')::bigint, size), updated_at = now() where id = tid;
  else
    insert into qt_templates (id, made_by, name, path, file_name, size) values (tid, me, n, p->>'path', p->>'file_name', (p->>'size')::bigint);
  end if;
  return tid;
end $$;

create or replace function public.qt_template_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare old qt_templates;
begin
  select * into old from qt_templates where id = p_id;
  if not found then return false; end if;
  if old.made_by <> current_employee_id() and not qt_is_lead() then raise exception 'Only the person who added it can delete it.'; end if;
  delete from qt_templates where id = p_id;
  return true;
end $$;

revoke all on function public.qt_templates_list(), public.qt_template_save(jsonb), public.qt_template_delete(uuid) from public, anon;
grant execute on function public.qt_templates_list(), public.qt_template_save(jsonb), public.qt_template_delete(uuid) to authenticated;

-- A template's file: its maker and the leads read it.
create or replace function public.qt_photo_ok(p_name text, p_write boolean)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $function$
declare rid uuid; r qt_requests; mk uuid;
begin
  begin rid := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  select * into r from qt_requests where id = rid;
  if not found then
    select made_by into mk from qt_quotes where id = rid;
    if found then return mk = current_employee_id() or qt_is_lead(); end if;
    select made_by into mk from qt_templates where id = rid;
    if found then return mk = current_employee_id() or qt_is_lead(); end if;
    return p_write and qt_me() is not null;
  end if;
  return qt_sees(r);
end $function$;

-- Word files allowed in the bucket.
update storage.buckets set allowed_mime_types = array_append(allowed_mime_types, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
 where id = 'qt-photos' and not ('application/vnd.openxmlformats-officedocument.wordprocessingml.document' = any (allowed_mime_types));

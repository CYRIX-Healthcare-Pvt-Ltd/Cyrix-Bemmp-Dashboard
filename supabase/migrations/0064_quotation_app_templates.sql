/*
  0064 (the user, 18 Nov: "why no edit / delete for namitha?, and on click not opening, but need to edit saved also"):
  the in-app format is a template of its own for each Coordinator, viewed as a sample PDF, edited (name, subject, terms)
  and deleted like a Word one. Only Coordinators and leads hold one; Namitha K V and Suhail KS start with Spares Quotation.
*/
alter table public.qt_templates add column if not exists kind text not null default 'word',
  add column if not exists doc jsonb;
alter table public.qt_templates alter column path drop not null;
do $$ begin
  alter table public.qt_templates add constraint qt_templates_kind check (kind in ('word', 'app'));
exception when duplicate_object then null; end $$;

create or replace function public.qt_templates_list() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name, 'doc', t.doc, 'path', t.path, 'file_name', t.file_name,
      'size', t.size, 'created_at', t.created_at, 'updated_at', t.updated_at, 'by_name', e.full_name, 'by_code', e.ecode,
      'mine', t.made_by = current_employee_id()) order by (t.kind = 'app') desc, t.updated_at desc), '[]'::jsonb)
  from qt_templates t join employees e on e.id = t.made_by
  where t.made_by = current_employee_id() or qt_is_lead()
$$;

create or replace function public.qt_template_save(p jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare me uuid := current_employee_id(); tid uuid := (p->>'id')::uuid; old qt_templates; n text := btrim(coalesce(p->>'name', ''));
  k text := coalesce(nullif(p->>'kind', ''), 'word');
begin
  if not qt_can_make() then raise exception 'Only a Quotation maker can save a template.'; end if;
  if n = '' then raise exception 'Write the template name.'; end if;
  select * into old from qt_templates where id = tid;
  if found then k := old.kind; end if;
  if k = 'app' then
    if coalesce(qt_role(), '') <> 'coordinator' and not qt_is_lead() then raise exception 'Only a Coordinator can keep this template.'; end if;
  else
    if coalesce(p->>'path', '') = '' then raise exception 'Choose the Word file.'; end if;
    if split_part(p->>'path', '/', 1) <> tid::text then raise exception 'Choose the Word file again.'; end if;
  end if;
  if found then
    if old.made_by <> me and not qt_is_lead() then raise exception 'Only the person who added it can change it.'; end if;
    update qt_templates set name = n, path = case when k = 'app' then null else p->>'path' end,
      file_name = case when k = 'app' then null else coalesce(p->>'file_name', file_name) end,
      size = case when k = 'app' then null else coalesce((p->>'size')::bigint, size) end,
      doc = case when k = 'app' then coalesce(p->'doc', doc, '{}'::jsonb) else null end, updated_at = now() where id = tid;
  else
    insert into qt_templates (id, made_by, kind, name, path, file_name, size, doc)
    values (tid, me, k, n, case when k = 'app' then null else p->>'path' end, case when k = 'app' then null else p->>'file_name' end,
            case when k = 'app' then null else (p->>'size')::bigint end, case when k = 'app' then coalesce(p->'doc', '{}'::jsonb) end);
  end if;
  return tid;
end $$;

insert into qt_templates (id, made_by, kind, name, doc)
select gen_random_uuid(), e.id, 'app', 'Spares Quotation', '{}'::jsonb
  from employees e where e.ecode in ('E1542', 'E2436')
   and not exists (select 1 from qt_templates t where t.made_by = e.id and t.kind = 'app');

/*
  0065 (the user, 18 Nov: "need apps own quotation pdf editor like now suhail has, for each upload, we need to save that
  quot letterhead, layouts etc"): an uploaded Word template keeps, beside the file, the layout read from it (letterhead
  pictures, letter, machine-table columns, totals, terms) in doc. Create quotation fills that layout in the app.
*/
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
      doc = coalesce(p->'doc', doc, case when k = 'app' then '{}'::jsonb end), updated_at = now() where id = tid;
  else
    insert into qt_templates (id, made_by, kind, name, path, file_name, size, doc)
    values (tid, me, k, n, case when k = 'app' then null else p->>'path' end, case when k = 'app' then null else p->>'file_name' end,
            case when k = 'app' then null else (p->>'size')::bigint end, coalesce(p->'doc', case when k = 'app' then '{}'::jsonb end));
  end if;
  return tid;
end $$;

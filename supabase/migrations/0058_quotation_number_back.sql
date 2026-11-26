/*
  0058: a QTN number comes back when its quotation is deleted before the request is submitted (the user, 16 Nov:
  "we need that number back"). Given-back numbers wait in qt_qtn.free and the next quotation made takes the lowest
  one of this financial year before a new number is given. A number on a submitted quotation (a row of
  qt_quote_files) is never given back; nor is a revision (… R1), whose number stays with the first one.
*/

create or replace function public.qt_next_qtn()
returns text language plpgsql security definer set search_path to 'public' as $f$
declare s jsonb; n int; d date := (now() at time zone 'Asia/Kolkata')::date; fy int; tail text; got text;
begin
  if coalesce(qt_role(), '') <> 'coordinator' and not qt_is_lead() then
    raise exception 'Only a Coordinator can make a quotation.';
  end if;
  select value into s from app_settings where key = 'qt_qtn' for update;
  if s is null then raise exception 'The QTN number series is not set.'; end if;
  fy := case when extract(month from d) >= 4 then extract(year from d)::int else extract(year from d)::int - 1 end;
  tail := coalesce(s->>'suffix', '') || '/' || fy || '-' || lpad(((fy + 1) % 100)::text, 2, '0');
  -- A number given back this year first, the lowest; any other year's are dropped.
  select x into got from jsonb_array_elements_text(coalesce(s->'free', '[]'::jsonb)) x
   where x like '%' || tail and not exists (select 1 from qt_quote_files q where q.qtn_no = x)
   order by nullif(regexp_replace(left(x, length(x) - length(tail)), '\D', '', 'g'), '')::int nulls last limit 1;
  if got is not null then
    update app_settings set value = s || jsonb_build_object('free',
      coalesce((select jsonb_agg(x) from jsonb_array_elements_text(s->'free') x where x like '%' || tail and x <> got), '[]'::jsonb))
     where key = 'qt_qtn';
    return got;
  end if;
  n := coalesce((s->>'next')::int, 1);
  update app_settings set value = s || jsonb_build_object('next', n + 1,
    'free', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(coalesce(s->'free', '[]'::jsonb)) x where x like '%' || tail), '[]'::jsonb))
   where key = 'qt_qtn';
  return coalesce(s->>'prefix', 'QTN') || n || tail;
end $f$;
revoke all on function public.qt_next_qtn() from public, anon;
grant execute on function public.qt_next_qtn() to authenticated;

create or replace function public.qt_release_qtn(p_qtn text)
returns boolean language plpgsql security definer set search_path to 'public' as $f$
declare s jsonb; q text := btrim(coalesce(p_qtn, '')); nn int;
begin
  if coalesce(qt_role(), '') <> 'coordinator' and not qt_is_lead() then
    raise exception 'Only a Coordinator can delete a quotation.';
  end if;
  select value into s from app_settings where key = 'qt_qtn' for update;
  -- Only a number of this series, never a revision, never one on a submitted quotation, never twice.
  if s is null or q = '' or q ~ ' R\d+$' or q not like coalesce(s->>'prefix', 'QTN') || '%'
     or exists (select 1 from qt_quote_files f where f.qtn_no = q)
     or coalesce(s->'free', '[]'::jsonb) ? q then
    return false;
  end if;
  -- and one that was given out: its number below the next one.
  nn := nullif(substring(substr(q, length(coalesce(s->>'prefix', 'QTN')) + 1) from '^(\d+)'), '')::int;
  if nn is null or nn >= coalesce((s->>'next')::int, 1) then return false; end if;
  update app_settings set value = s || jsonb_build_object('free', coalesce(s->'free', '[]'::jsonb) || to_jsonb(q)) where key = 'qt_qtn';
  return true;
end $f$;
revoke all on function public.qt_release_qtn(text) from public, anon;
grant execute on function public.qt_release_qtn(text) to authenticated;

/* By hand: the person it was handed to, found by name or employee code (the user, 11 Nov). Members only, active people, 8 at most. */
create or replace function public.qt_find_person(p_q text) returns table (ecode text, name text)
language sql stable security definer set search_path = public as $$
  select e.ecode, e.full_name from employees e
  where qt_me() is not null and e.is_active and length(btrim(coalesce(p_q, ''))) >= 2
    and (e.ecode ilike btrim(p_q) || '%' or e.full_name ilike '%' || btrim(p_q) || '%')
    and e.full_name not ilike '%- test%'
  order by (e.ecode ilike btrim(p_q) || '%') desc, e.full_name
  limit 8
$$;
revoke execute on function public.qt_find_person(text) from public, anon;
grant execute on function public.qt_find_person(text) to authenticated;

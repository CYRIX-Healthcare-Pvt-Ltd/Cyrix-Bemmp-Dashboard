/*
  0056: Engineers and Team Leads never get the rates (the user, 14 Nov: "hide rates from engineer and team lead too").
  qt_list / qt_one leave out the purchase rates, taxes, Purchase's quote photos and note for a caller whose tracker role
  is engineer or team_lead (BEMMP admins and every other role see them as before), so the screens, the Excel and the
  browser all go without. Mails stay as they were (the user, 14 Nov: "in mail as usual").
  The quotation's own total (the customer's price, read from the PDF) stays: the engineer takes it to the customer.
*/
create or replace function public.qt_hidden_keys()
returns text[] language sql stable security definer set search_path to 'public' as $f$
  select case
    when coalesce((select role::text = 'admin' from profile where id = auth.uid()), false) then '{}'::text[]
    when (select role from qt_people where employee_id = current_employee_id()) in ('engineer', 'team_lead')
      then array['orig_rate', 'orig_tax', 'comp_rate', 'comp_tax', 'orig_photo', 'comp_photo', 'purchase_note']
    else '{}'::text[] end
$f$;
revoke all on function public.qt_hidden_keys() from public, anon;
grant execute on function public.qt_hidden_keys() to authenticated;

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.qt_list'::regproc);
  n := replace(d, 'jsonb_agg((to_jsonb(r) - ''client_token'') ||', 'jsonb_agg((to_jsonb(r) - ''client_token'' - hk.k) ||');
  n := replace(n, 'left join employees e on e.id = r.engineer_id', 'cross join (select qt_hidden_keys() k) hk left join employees e on e.id = r.engineer_id');
  if n = d or position('hk.k' in n) = 0 or position('cross join' in n) = 0 then raise exception 'qt_list: nothing replaced'; end if;
  execute n;

  d := pg_get_functiondef('public.qt_one'::regproc);
  n := replace(d, 'return to_jsonb(r) || jsonb_build_object(', 'return (to_jsonb(r) - qt_hidden_keys()) || jsonb_build_object(');
  if n = d then raise exception 'qt_one: nothing replaced'; end if;
  execute n;

end $mig$;

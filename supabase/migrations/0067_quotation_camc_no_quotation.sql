/*
  0067 — A CAMC request needs no quotation (the user, 18 Nov: "for camc facilities, quotation flow is skipped ie from
  pr"). The Team Lead's approval already sends CAMC straight to PR (0015), but 0033's rule — a hospital request waits
  at the quotation before PR — caught it and moved it to "preparing quotation" (QR-193). CAMC is left out of that
  rule: no quotation, no customer approval, the PR next.
*/
do $$
declare f text;
  a text := $q$if p_to = 'coord_pr' and r.kind = 'request' and r.quote_ok is not true then p_to := 'coord_quote'; end if;$q$;
begin
  f := pg_get_functiondef('public.qt_move(uuid, text, text, text, boolean)'::regprocedure);
  if position(a in f) = 0 then raise exception 'qt_move changed'; end if;
  f := replace(f, a, $q$if p_to = 'coord_pr' and r.kind = 'request' and r.quote_ok is not true
    and upper(coalesce(r.category, '')) <> 'CAMC' then p_to := 'coord_quote'; end if;$q$);
  execute f;
end $$;

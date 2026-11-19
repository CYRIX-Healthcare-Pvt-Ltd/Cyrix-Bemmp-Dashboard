-- =====================================================================
-- BEMMP · 0071 · Spares received before for the same barcode
--
-- The user, 19 Nov: "we need to show that repeated spare request for each
-- barcode, ie coord, tl, pv, pur they need to see equipment purchase
-- history", "spare history only should consider successful closure of
-- ticket spares, not cancelled ones", "what if more than 10 comes?".
-- Received = received_on set and not cancelled. Coordinator, Team Lead, PV
-- and Purchase see every request for the barcode; others see nothing here.
-- =====================================================================

create or replace function qt_sees_history()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from qt_people where employee_id = current_employee_id()
                 and role in ('coordinator', 'team_lead', 'pv', 'purchase'))
$$;

-- How many received spares each barcode has, for the "3rd time" tag on the cards.
create or replace function qt_barcode_counts()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when qt_sees_history() then coalesce((
    select jsonb_object_agg(b, n) from (
      select upper(btrim(barcode)) b, count(*) n from qt_requests
      where nullif(btrim(barcode), '') is not null and received_on is not null and step <> 'cancelled'
      group by 1) x), '{}'::jsonb)
  else '{}'::jsonb end
$$;

-- The received spares of one barcode, newest first, other than the request itself.
create or replace function qt_barcode_history(p_barcode text, p_except uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when qt_sees_history() and nullif(btrim(coalesce(p_barcode, '')), '') is not null then coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'no', r.no, 'spare', r.spare,
      'qty', coalesce(r.received_qty, r.approved_qty, r.qty),
      'received_on', r.received_on,
      'amount', round(coalesce(case r.picked when 'original' then r.orig_rate when 'compatible' then r.comp_rate end, 0)
                      * coalesce(r.received_qty, r.approved_qty, r.qty))
    ) order by r.received_on desc, r.no desc)
    from qt_requests r
    where upper(btrim(r.barcode)) = upper(btrim(p_barcode)) and r.received_on is not null and r.step <> 'cancelled'
      and r.id is distinct from p_except), '[]'::jsonb)
  else '[]'::jsonb end
$$;

revoke all on function qt_sees_history() from public, anon;
revoke all on function qt_barcode_counts() from public, anon;
revoke all on function qt_barcode_history(text, uuid) from public, anon;
grant execute on function qt_sees_history() to authenticated;
grant execute on function qt_barcode_counts() to authenticated;
grant execute on function qt_barcode_history(text, uuid) to authenticated;

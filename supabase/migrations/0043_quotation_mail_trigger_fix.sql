/*
 * 0042's mail trigger read new.by, but "by" is an SQL keyword and must be quoted: every raise was
 * refused with 'record "new" has no field "by"' (the user, 12 Nov, a field engineer's screenshot).
 * Same trigger with new."by"; and a mail problem can never stop the request itself again.
 */
create or replace function public.qt_mail_queue() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; m text; eng uuid; who uuid;
begin
  begin
    m := qt_mail_mode();
    who := new."by";
    k := case when new.action = 'raise' then 'raised'
              when new.action = 'quote_yes' then 'quote_ok'
              when new.action in ('rates', 'rates_pr') then 'rates' end;
    if k is null or m = 'off' then return new; end if;
    select engineer_id into eng from qt_requests where id = new.request_id;
    if m = 'test' and not qt_is_test(coalesce(eng, who)) then return new; end if;
    insert into qt_mails (kind, request_id, by_id) values (k, new.request_id, who);
  exception when others then
    raise warning 'qt_mail_queue: %', sqlerrm;
  end;
  return new;
end $$;

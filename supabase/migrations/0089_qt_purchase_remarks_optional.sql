-- 0089: Send to Purchase for rates — remarks optional (the user, 25 Nov). Every other action still needs them.
do $m$
declare d text := pg_get_functiondef('public.qt_coord_initial'::regproc);
  o text := 'perform qt_need(p->>''note'', ''remarks'');';
begin
  if position(o in d) = 0 then raise exception '0089: anchor not found'; end if;
  execute replace(d, o, 'if coalesce(p->>''action'', '''') <> ''to_purchase'' then perform qt_need(p->>''note'', ''remarks''); end if;');
end $m$;

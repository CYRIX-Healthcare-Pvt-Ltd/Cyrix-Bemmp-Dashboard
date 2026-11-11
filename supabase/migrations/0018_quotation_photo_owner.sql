-- Quotation tracker: a photo just added to a request still being raised is shown to the person who added it
-- (its request has no row yet, so qt_photo_ok refused the read and the thumbnail stayed blank; 11 Nov 2026).
drop policy if exists qt_photos_read on storage.objects;
create policy qt_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'qt-photos' and (owner = auth.uid() or public.qt_photo_ok(name, false)));

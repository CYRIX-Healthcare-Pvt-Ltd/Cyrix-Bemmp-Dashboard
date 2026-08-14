-- ============================================================================
-- Immutable artifact paths.
--
-- The two objects lived at one fixed path each, overwritten on every publish,
-- and Storage serves them with `cache-control: max-age=3600`. So for an hour
-- after a publish a browser could hold the previous 27 MB `tickets.bin.gz` in
-- its own HTTP cache while fetching the new `meta.json.gz` over the network — a
-- meta describing 270,293 rows paired with a buffer holding 270,030. Every
-- figure would be read out of the wrong column, so the reader refuses the pair
-- and the page is dead until the cache expires.
--
-- That is not a rare race. Anybody who opened the dashboard in the hour before a
-- publish hit it, which is how one publish took the deployment down for a
-- morning.
--
-- The fix is to stop rewriting paths. Each publish writes `<state>/<version>/`
-- and this column is the pointer, so the switch is a single-row update and the
-- bytes behind any given URL never change — which also makes caching them for a
-- year correct rather than dangerous.
--
-- Null means an artifact published before this, still at the old flat paths;
-- `paths()` in src/data/datasets.js reads those unchanged.
-- ============================================================================

alter table dataset add column if not exists version text;

-- --------------------------------------------------------------- storage ---

/*
 * A publish now sweeps the version it replaced, so the bucket does not grow by
 * 27 MB every time somebody uploads. Same scope test as writing: your own
 * contract, and not a director.
 *
 * `(storage.foldername(name))[1]` is still the contract — the version is a
 * second segment below it, so the existing read/insert/update policies need no
 * change.
 */
drop policy if exists "datasets delete in scope" on storage.objects;
create policy "datasets delete in scope" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'datasets'
    and in_scope ((storage.foldername (name))[1])
    and not is_director ()
  );

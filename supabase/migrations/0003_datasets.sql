-- ============================================================================
-- Shared ticket artifacts.
--
-- Until now a TM export uploaded in the browser stayed in that browser's
-- IndexedDB, so every person had to upload the same file for themselves. One
-- upload should serve the team.
--
-- The artifact is a file, not a table: 27 MB of concatenated Int32Array columns
-- that the browser slices into typed arrays with zero parse cost. Putting 265k
-- rows into Postgres would throw away the entire reason the columnar format
-- exists, so the bytes live in Storage and only the provenance lives here.
-- ============================================================================

create table if not exists dataset (
  state       text primary key check (state in ('kl', 'ap')),
  rows        integer not null,
  min_day     integer not null,
  max_day     integer not null,
  filename    text,
  bytes       bigint,
  -- Both objects are gzipped client-side before upload. Recorded rather than
  -- assumed so a future raw upload can still be read back.
  encoding    text not null default 'gzip',
  uploaded_by uuid references auth.users on delete set null,
  uploaded_at timestamptz not null default now()
);

alter table dataset enable row level security;

drop policy if exists dataset_read on dataset;
create policy dataset_read on dataset
  for select to authenticated using (in_scope (state));

-- Same rule as editing the meeting: your own contract, and not a director.
-- Replacing the artifact changes what every figure on the page is computed
-- from, so it is emphatically not a read-only person's action.
drop policy if exists dataset_write on dataset;
create policy dataset_write on dataset
  for all to authenticated
  using (in_scope (state) and not is_director ())
  with check (in_scope (state) and not is_director ());

-- --------------------------------------------------------------- storage ---

insert into storage.buckets (id, name, public)
values ('datasets', 'datasets', false)
on conflict (id) do nothing;

/*
 * Objects are `<state>/meta.json.gz` and `<state>/tickets.bin.gz`, so the first
 * path segment is the contract and scope can be enforced on it directly. A
 * private bucket, so every read is a signed request carrying the user's session
 * rather than a public URL anyone could pass around.
 */
drop policy if exists "datasets read in scope" on storage.objects;
create policy "datasets read in scope" on storage.objects
  for select to authenticated
  using (bucket_id = 'datasets' and in_scope ((storage.foldername (name))[1]));

drop policy if exists "datasets insert in scope" on storage.objects;
create policy "datasets insert in scope" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'datasets'
    and in_scope ((storage.foldername (name))[1])
    and not is_director ()
  );

drop policy if exists "datasets update in scope" on storage.objects;
create policy "datasets update in scope" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'datasets'
    and in_scope ((storage.foldername (name))[1])
    and not is_director ()
  );

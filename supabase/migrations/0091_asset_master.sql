-- =====================================================================
-- BEMMP · 0091 · Asset master for Care 360 and Private Service
--
-- The user, 26 Nov: "for care360 and private service we need option to upload asset master also … amc camc we can
-- take from asset file". The workbook is read in the uploader's browser; only Barcode → Contract Category (and a
-- few names) goes to storage as datasets/<contract>/assets/<version>.json.gz, already covered by the datasets
-- bucket's in_scope rules. This row says which version is current, like `dataset` does for the ticket export.
-- =====================================================================

create table if not exists public.asset_master (
  state            text primary key check (state in ('c360', 'pvt')),
  rows             integer not null,
  filename         text,
  bytes            bigint,
  version          text not null,
  categories       jsonb not null default '{}'::jsonb,
  uploaded_by      uuid references auth.users (id) on delete set null,
  uploaded_by_code text,
  uploaded_by_name text,
  uploaded_at      timestamptz not null default now()
);

alter table public.asset_master enable row level security;

drop policy if exists asset_master_read on public.asset_master;
create policy asset_master_read on public.asset_master for select to authenticated using (in_scope(state));

drop policy if exists asset_master_write on public.asset_master;
create policy asset_master_write on public.asset_master for all to authenticated
  using (in_scope(state) and not is_director())
  with check (in_scope(state) and not is_director());

revoke all on public.asset_master from anon;
grant select, insert, update, delete on public.asset_master to authenticated;

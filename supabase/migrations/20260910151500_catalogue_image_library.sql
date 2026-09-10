create extension if not exists vector with schema extensions;

create table if not exists public.catalogue_image_assets (
  source_image_url text primary key,
  storage_path text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  pixel_sha256 text not null check (pixel_sha256 ~ '^[a-f0-9]{64}$'),
  fingerprint_version text not null,
  fingerprint extensions.vector(256) not null,
  descriptor text not null,
  aspect_ratio real not null check (aspect_ratio > 0),
  searchable boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.catalogue_image_assets enable row level security;
-- Public catalogue derivatives only. Customer uploads are never stored here.
create policy "read catalogue image fingerprints" on public.catalogue_image_assets
  for select to anon, authenticated using (true);
grant select on public.catalogue_image_assets to anon, authenticated;
grant all on public.catalogue_image_assets to service_role;
create index if not exists catalogue_image_content_hash on public.catalogue_image_assets(content_sha256);
create index if not exists catalogue_image_pixel_hash on public.catalogue_image_assets(pixel_sha256);
create index if not exists catalogue_image_nearest on public.catalogue_image_assets
  using hnsw (fingerprint extensions.vector_l2_ops) where searchable;
create index if not exists products_image_url on public.products(image_url);

create or replace function public.match_catalogue_images(
  query_fingerprint extensions.vector(256), query_content_hash text, query_pixel_hash text,
  query_version text default 'raster-v1', result_limit integer default 16
)
returns table(source_image_url text, content_sha256 text, pixel_sha256 text,
  descriptor text, aspect_ratio real, products jsonb)
language sql stable security invoker
set search_path = ''
as $$
  with exact as (
    select a.source_image_url from public.catalogue_image_assets a
    where a.searchable and a.fingerprint_version = query_version
      and (a.content_sha256 = query_content_hash or a.pixel_sha256 = query_pixel_hash)
    limit 100
  ), nearest as (
    select a.source_image_url from public.catalogue_image_assets a
    where a.searchable and a.fingerprint_version = query_version
    order by a.fingerprint operator(extensions.<->) query_fingerprint
    limit least(greatest(result_limit, 1), 30)
  ), chosen as (select * from exact union select * from nearest)
  select a.source_image_url, a.content_sha256, a.pixel_sha256, a.descriptor, a.aspect_ratio,
    (select jsonb_agg(jsonb_build_object('stock_id', p.stock_id, 'name', p.name))
      from public.products p where p.image_url = a.source_image_url
        and p.status in ('Active','New') and p.source_url is not null) as products
  from chosen c join public.catalogue_image_assets a using (source_image_url);
$$;
revoke all on function public.match_catalogue_images(extensions.vector,text,text,text,integer) from public;
grant execute on function public.match_catalogue_images(extensions.vector,text,text,text,integer) to anon, authenticated, service_role;

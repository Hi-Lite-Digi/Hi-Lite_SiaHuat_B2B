-- Exhaustively rank this compact catalogue: approximate HNSW missed resized originals during QA.
drop index if exists public.catalogue_image_nearest;
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
    order by (a.fingerprint operator(extensions.<->) query_fingerprint) + 0
    limit least(greatest(result_limit, 1), 30)
  ), chosen as (select * from exact union select * from nearest)
  select a.source_image_url, a.content_sha256, a.pixel_sha256, a.descriptor, a.aspect_ratio,
    (select jsonb_agg(jsonb_build_object('stock_id', p.stock_id, 'name', p.name))
      from public.products p where p.image_url = a.source_image_url
        and p.status in ('Active','New') and p.source_url is not null) as products
  from chosen c join public.catalogue_image_assets a using (source_image_url);
$$;

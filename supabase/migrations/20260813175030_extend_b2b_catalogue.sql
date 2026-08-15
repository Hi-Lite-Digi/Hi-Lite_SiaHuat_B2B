alter table public.products
  add column if not exists source_stock_id text,
  add column if not exists source_product_id text,
  add column if not exists source_url text,
  add column if not exists image_url text,
  add column if not exists description text,
  add column if not exists size text,
  add column if not exists dimensions text,
  add column if not exists brand text,
  add column if not exists model text,
  add column if not exists price_ex_gst numeric(14,2),
  add column if not exists in_stock boolean,
  add column if not exists available_quantity numeric,
  add column if not exists stock_status text not null default 'unknown'
    check (stock_status in ('in_stock', 'out_of_stock', 'unknown')),
  add column if not exists category text,
  add column if not exists subcategory text,
  add column if not exists third_category text,
  add column if not exists attributes jsonb not null default '{}'::jsonb,
  add column if not exists last_scraped_at timestamptz,
  add column if not exists scrape_checksum text;

create unique index if not exists products_source_product_id_idx
  on public.products(source_product_id) where source_product_id is not null;
create index if not exists products_in_stock_idx on public.products(in_stock);
create index if not exists products_category_idx on public.products(category, subcategory);
create index if not exists products_brand_idx on public.products(brand);

drop function if exists public.search_products(text, integer);
create or replace function public.search_products(search_query text, result_limit integer default 5)
returns table(
  id bigint, stock_id text, name text, brand_id text, status text,
  list_price numeric, uom_id text, source_url text, image_url text,
  description text, size text, dimensions text, brand text, model text,
  in_stock boolean, available_quantity numeric, stock_status text,
  category text, subcategory text, third_category text,
  last_scraped_at timestamptz, score real
)
language sql stable security invoker set search_path=''
as $$
  select p.id, p.stock_id, p.name, p.brand_id, p.status, p.list_price, p.uom_id,
    p.source_url, p.image_url, p.description, p.size, p.dimensions, p.brand, p.model,
    p.in_stock, p.available_quantity, p.stock_status, p.category, p.subcategory,
    p.third_category, p.last_scraped_at,
    (case when lower(p.stock_id)=lower(trim(search_query)) then 100 else 0 end
      + case when p.stock_id ilike trim(search_query)||'%' then 30 else 0 end
      + extensions.similarity(p.name,trim(search_query))*12
      + ts_rank(p.search_document,plainto_tsquery('simple',trim(search_query)))*8
      + case when p.in_stock then 2 else 0 end)::real score
  from public.products p
  where length(trim(search_query))>=2 and (
    p.stock_id ilike '%'||trim(search_query)||'%'
    or p.name ilike '%'||trim(search_query)||'%'
    or p.brand_id ilike '%'||trim(search_query)||'%'
    or p.brand ilike '%'||trim(search_query)||'%'
    or p.category ilike '%'||trim(search_query)||'%'
    or p.description ilike '%'||trim(search_query)||'%'
    or p.search_document@@plainto_tsquery('simple',trim(search_query))
    or extensions.similarity(p.name,trim(search_query))>.18
  )
  order by score desc,p.name
  limit greatest(1,least(coalesce(result_limit,5),10));
$$;

revoke all on function public.search_products(text,integer) from public,anon,authenticated;
grant execute on function public.search_products(text,integer) to service_role;

-- Product data mirrors the public Sia Huat store, so the local demo and n8n
-- may read it with a publishable key. RLS remains enabled and all write access
-- stays restricted to administrative roles.
grant usage on schema public to anon, authenticated;
grant select on public.products to anon, authenticated;
grant execute on function public.search_products(text,integer) to anon, authenticated;

drop policy if exists "public can read website catalogue" on public.products;
create policy "public can read website catalogue"
on public.products for select
to anon, authenticated
using (source_url is not null);

-- Round 10: the salespeople's product names (sales_name) are searched like the store's, and among similar matches better sellers
-- rank higher. The popularity boost multiplies only the text score, by at most 1.25: a code match (30 or 100 points) always wins,
-- and a product whose text score is 25% or more above another's stays above it however well the other sells.
alter table public.products
  add column if not exists sales_document tsvector
  generated always as (to_tsvector('simple', coalesce(sales_name, ''))) stored;

drop function if exists public.search_products(text, integer);
create function public.search_products(search_query text, result_limit integer default 5)
returns table(
  id bigint, stock_id text, name text, brand_id text, status text,
  list_price numeric, uom_id text, source_url text, image_url text,
  description text, size text, dimensions text, brand text, model text,
  in_stock boolean, available_quantity numeric, stock_status text,
  category text, subcategory text, third_category text,
  last_scraped_at timestamptz, popularity smallint, best_seller boolean, sales_name text, score real
)
language sql stable security invoker set search_path=''
as $$
  select p.id, p.stock_id, p.name, p.brand_id, p.status, p.list_price, p.uom_id,
    p.source_url, p.image_url, p.description, p.size, p.dimensions, p.brand, p.model,
    p.in_stock, p.available_quantity, p.stock_status, p.category, p.subcategory,
    p.third_category, p.last_scraped_at, p.popularity, p.best_seller, p.sales_name,
    (case when lower(p.stock_id)=lower(trim(search_query)) then 100 else 0 end
      + case when p.stock_id ilike trim(search_query)||'%' then 30 else 0 end
      -- The better of the two names, never both added: a renamed product scores as its old name would.
      + (greatest(extensions.similarity(p.name,trim(search_query)), extensions.similarity(p.sales_name,trim(search_query)))*12
        + greatest(ts_rank(p.search_document,plainto_tsquery('simple',trim(search_query))),
                   ts_rank(p.sales_document,plainto_tsquery('simple',trim(search_query))))*8)
        * (1 + 0.25*coalesce(p.popularity,0)/100.0)
      + case when p.in_stock then 2 else 0 end)::real score
  from public.products p
  where length(trim(search_query))>=2 and (
    p.stock_id ilike '%'||trim(search_query)||'%'
    or p.name ilike '%'||trim(search_query)||'%'
    or p.sales_name ilike '%'||trim(search_query)||'%'
    or p.brand_id ilike '%'||trim(search_query)||'%'
    or p.brand ilike '%'||trim(search_query)||'%'
    or p.category ilike '%'||trim(search_query)||'%'
    or p.description ilike '%'||trim(search_query)||'%'
    or p.search_document@@plainto_tsquery('simple',trim(search_query))
    or p.sales_document@@plainto_tsquery('simple',trim(search_query))
    -- No similarity arm for sales_name: this query scans every row, and a second trigram per row is its dearest new cost. The two
    -- arms above find a renamed product by its sales name.
    or extensions.similarity(p.name,trim(search_query))>.18
  )
  order by score desc,p.name
  limit greatest(1,least(coalesce(result_limit,5),10));
$$;

revoke all on function public.search_products(text,integer) from public,anon,authenticated;
grant execute on function public.search_products(text,integer) to service_role, anon, authenticated;

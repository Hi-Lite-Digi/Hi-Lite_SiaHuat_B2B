create extension if not exists pg_trgm with schema extensions;
create table public.products (id bigint generated always as identity primary key, stock_id text not null unique, name text not null, brand_id text, status text not null check (status in ('Active','New','Discontinued')), list_price numeric(14,2) not null check (list_price >= 0), uom_id text not null, source_row integer, search_document tsvector generated always as (to_tsvector('simple',coalesce(stock_id,'')||' '||coalesce(name,'')||' '||coalesce(brand_id,''))) stored, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index products_search_idx on public.products using gin(search_document);
create index products_name_trgm_idx on public.products using gin(name extensions.gin_trgm_ops);
create index products_status_idx on public.products(status);
create table public.enquiries (id uuid primary key default gen_random_uuid(), query text not null, matched_product_ids bigint[] not null default '{}', draft_response text not null, source text not null default 'demo', status text not null default 'draft' check(status in ('draft','approved','rejected')), created_at timestamptz not null default now());
alter table public.products enable row level security;
alter table public.enquiries enable row level security;
revoke all on public.products from anon, authenticated;
revoke all on public.enquiries from anon, authenticated;
grant all on public.products to service_role;
grant all on public.enquiries to service_role;
grant usage, select on sequence public.products_id_seq to service_role;
create or replace function public.search_products(search_query text, result_limit integer default 5)
returns table(id bigint,stock_id text,name text,brand_id text,status text,list_price numeric,uom_id text,score real)
language sql stable security invoker set search_path=''
as $$ select p.id,p.stock_id,p.name,p.brand_id,p.status,p.list_price,p.uom_id,(case when lower(p.stock_id)=lower(trim(search_query)) then 100 else 0 end+case when p.stock_id ilike trim(search_query)||'%' then 30 else 0 end+extensions.similarity(p.name,trim(search_query))*12+ts_rank(p.search_document,plainto_tsquery('simple',trim(search_query)))*8+case p.status when 'Active' then 2 when 'New' then 1 else 0 end)::real score from public.products p where length(trim(search_query))>=2 and (p.stock_id ilike '%'||trim(search_query)||'%' or p.name ilike '%'||trim(search_query)||'%' or p.brand_id ilike '%'||trim(search_query)||'%' or p.search_document@@plainto_tsquery('simple',trim(search_query)) or extensions.similarity(p.name,trim(search_query))>.18) order by score desc,p.name limit greatest(1,least(coalesce(result_limit,5),10)); $$;
revoke all on function public.search_products(text,integer) from public,anon,authenticated;
grant execute on function public.search_products(text,integer) to service_role;

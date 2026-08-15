create unique index if not exists enquiries_review_request_unique_idx
on public.enquiries (session_id, selected_stock_id, quantity)
where submitted_at is not null;

create or replace function public.submit_enquiry_for_review(
  request_session_id text,
  request_query text,
  request_stock_id text,
  request_quantity numeric
)
returns table(
  enquiry_id uuid,
  stock_id text,
  product_name text,
  quantity numeric,
  unit_price numeric,
  estimated_total numeric,
  uom_id text,
  review_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  product_record public.products%rowtype;
  new_enquiry_id uuid;
begin
  if length(trim(request_session_id)) < 8 then
    raise exception 'A valid session ID is required';
  end if;
  if request_quantity is null or request_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select * into product_record
  from public.products p
  where lower(p.stock_id) = lower(trim(request_stock_id))
    and p.status in ('Active', 'New')
  limit 1;

  if not found then
    raise exception 'Product is not available for review';
  end if;

  insert into public.enquiries (
    query,
    matched_product_ids,
    draft_response,
    source,
    status,
    session_id,
    selected_stock_id,
    quantity,
    unit_price,
    estimated_total,
    submitted_at
  ) values (
    left(trim(request_query), 500),
    array[product_record.id],
    format(
      '%s x %s (SKU %s) at %s per %s. Estimated total: %s. Pending sales review.',
      request_quantity,
      product_record.name,
      product_record.stock_id,
      product_record.list_price,
      product_record.uom_id,
      round(request_quantity * product_record.list_price, 2)
    ),
    'web-chat',
    'draft',
    trim(request_session_id),
    product_record.stock_id,
    request_quantity,
    product_record.list_price,
    round(request_quantity * product_record.list_price, 2),
    now()
  )
  on conflict (session_id, selected_stock_id, quantity)
    where submitted_at is not null
  do update set updated_at = now()
  returning id into new_enquiry_id;

  return query
  select
    new_enquiry_id,
    product_record.stock_id,
    product_record.name,
    request_quantity,
    product_record.list_price,
    round(request_quantity * product_record.list_price, 2),
    product_record.uom_id,
    'draft'::text;
end;
$$;

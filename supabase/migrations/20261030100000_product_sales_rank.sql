-- Round 10: coarse ranks from Sia Huat's year-to-date sales, written by scripts/import-sales.ts. No quantities, prices or ABC classes
-- are stored. popularity is a 0-100 percentile of sales within the product's type (0: no sales this year), best_seller marks the
-- top few of its type, and sales_name is the salespeople's name for the product, used only to search. Null: no sales data.
-- Like every products column these are readable with the publishable key (policy "public can read website catalogue").
alter table public.products
  add column if not exists popularity smallint check (popularity between 0 and 100),
  add column if not exists best_seller boolean,
  add column if not exists sales_name text;

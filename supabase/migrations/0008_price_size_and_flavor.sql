-- 0008_price_size_and_flavor.sql
-- Per-listing pack size (in ounces) and flavor/variant on each price row, so the
-- app can show price-per-ounce value and label when a store only carries a
-- different flavor of the same product.
alter table prices add column if not exists pack_size_oz numeric;
alter table prices add column if not exists flavor text;

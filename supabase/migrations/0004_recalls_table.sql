-- BestBowl recalls table
--
-- FDA pet-food recall records imported from the openFDA enforcement API
-- (scripts/import-fda-recalls.js). RLS enabled with a read-all policy.

CREATE TABLE IF NOT EXISTS recalls (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand               TEXT,
  product_description TEXT,
  recall_date         DATE,
  reason              TEXT,
  status              TEXT,
  recalling_firm      TEXT,
  imported_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Recall lookups are by brand + recency, so index brand.
CREATE INDEX IF NOT EXISTS recalls_brand_idx ON recalls (brand);

ALTER TABLE recalls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all reads" ON recalls;
CREATE POLICY "Allow all reads" ON recalls FOR SELECT USING (true);

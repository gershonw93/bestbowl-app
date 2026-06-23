-- BestBowl ingredients table
--
-- Real ingredient data imported from Open Pet Food Facts (scripts/import-opff.js).
-- One row per product UPC. RLS enabled with a read-all policy, consistent with
-- the other tables; writes are done by the importer using the service role key.

CREATE TABLE IF NOT EXISTS ingredients (
  upc                          TEXT PRIMARY KEY REFERENCES products(upc),
  ingredients_text             TEXT,
  protein_percent              DECIMAL,
  fat_percent                  DECIMAL,
  fiber_percent                DECIMAL,
  first_ingredient             TEXT,
  has_corn                     BOOLEAN,
  has_wheat                    BOOLEAN,
  has_soy                      BOOLEAN,
  has_artificial_preservatives BOOLEAN,
  has_byproducts               BOOLEAN,
  raw_data                     JSONB,
  imported_at                  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all reads" ON ingredients;
CREATE POLICY "Allow all reads" ON ingredients FOR SELECT USING (true);

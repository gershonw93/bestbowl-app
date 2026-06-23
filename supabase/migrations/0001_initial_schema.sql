-- BestBowl initial backend schema
-- Tables: products, prices, quality_scores, restock_trackers
-- RLS: enabled on all tables with a permissive "allow all reads" policy for now.
--      (Write access is performed by server-side scripts using the service role
--       key, which bypasses RLS. Read/write policies will be tightened once auth
--       is added.)

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  upc         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  brand       TEXT,
  category    TEXT CHECK (category IN ('dog_dry','dog_wet','dog_treat','cat_dry','cat_wet','cat_treat')),
  life_stage  TEXT CHECK (life_stage IN ('puppy','adult','senior','all_life_stages')),
  weight_lbs  DECIMAL,
  image_url   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- prices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upc                  TEXT REFERENCES products(upc),
  store                TEXT NOT NULL CHECK (store IN ('chewy','amazon','walmart','petsmart','petco')),
  price                DECIMAL NOT NULL,
  autoship_price       DECIMAL,        -- nullable: not all stores have autoship
  subscribe_save_price DECIMAL,        -- nullable: Amazon specific
  in_stock             BOOLEAN DEFAULT true,
  affiliate_url        TEXT,
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT prices_upc_store_unique UNIQUE (upc, store)
);

-- ---------------------------------------------------------------------------
-- quality_scores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quality_scores (
  upc              TEXT PRIMARY KEY REFERENCES products(upc),
  overall_score    DECIMAL,            -- 0-10, one decimal place
  ingredient_score DECIMAL,            -- 0-5
  safety_score     DECIMAL,            -- 0-3
  aafco_score      DECIMAL,            -- 0-2
  first_ingredient TEXT,
  protein_percent  DECIMAL,
  recall_count     INTEGER DEFAULT 0,
  aafco_certified  BOOLEAN DEFAULT false,
  has_fillers      BOOLEAN DEFAULT false,  -- true if corn, wheat, or soy in top 5 ingredients
  scoring_notes    TEXT,
  scored_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- restock_trackers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restock_trackers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID,             -- will reference auth.users later; nullable for now
  upc                TEXT REFERENCES products(upc),
  pet_name           TEXT,
  pet_type           TEXT CHECK (pet_type IN ('dog','cat')),
  bag_size_lbs       DECIMAL NOT NULL,
  daily_serving_cups DECIMAL NOT NULL,
  purchase_date      DATE NOT NULL,
  notify_days_before INTEGER DEFAULT 5,
  is_active          BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: enable on all tables, allow all reads for now.
-- ---------------------------------------------------------------------------
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE prices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_scores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE restock_trackers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all reads" ON products;
CREATE POLICY "Allow all reads" ON products         FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow all reads" ON prices;
CREATE POLICY "Allow all reads" ON prices           FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow all reads" ON quality_scores;
CREATE POLICY "Allow all reads" ON quality_scores   FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow all reads" ON restock_trackers;
CREATE POLICY "Allow all reads" ON restock_trackers FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- calculate_days_remaining(): used by the scheduled restock job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calculate_days_remaining(
  bag_size_lbs DECIMAL,
  daily_serving_cups DECIMAL,
  purchase_date DATE
) RETURNS INTEGER AS $$
  SELECT FLOOR(
    (bag_size_lbs * 16 / (daily_serving_cups * 0.25))
    - EXTRACT(DAY FROM NOW() - purchase_date::TIMESTAMPTZ)
  )::INTEGER;
$$ LANGUAGE SQL;

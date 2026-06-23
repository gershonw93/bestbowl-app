/**
 * import-chewy.js
 *
 * Imports the Chewy affiliate product feed into Supabase.
 *
 *   1. Loads the feed from CHEWY_FEED_URL if set, otherwise falls back to the
 *      local mock file scripts/mock-chewy-data.json.
 *   2. Upserts each product into the `products` table (insert if new UPC,
 *      update if it already exists).
 *   3. Upserts the price into the `prices` table with store = 'chewy'.
 *   4. Logs progress: processed / inserted / updated / errors.
 *
 * Environment variables (see .env.example):
 *   SUPABASE_URL                - your Supabase project URL                (required)
 *   SUPABASE_ANON_KEY           - anon/public key                          (required)
 *   SUPABASE_SERVICE_ROLE_KEY   - service role key                         (recommended)
 *   CHEWY_FEED_URL              - affiliate feed URL                       (optional)
 *
 * NOTE on keys: RLS is enabled on every table with read-only policies, so the
 * anon key cannot write. Data scripts should therefore use the service role
 * key, which bypasses RLS. The script prefers SUPABASE_SERVICE_ROLE_KEY and
 * falls back to SUPABASE_ANON_KEY (reads only) if it is not set.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const CHEWY_FEED_URL = process.env.CHEWY_FEED_URL;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '⚠  SUPABASE_SERVICE_ROLE_KEY not set — using the anon key. Writes will be ' +
      'blocked by RLS. Set the service role key to import data.\n'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const MOCK_PATH = path.join(__dirname, 'mock-chewy-data.json');

async function loadFeed() {
  if (CHEWY_FEED_URL) {
    console.log(`Downloading Chewy feed from ${CHEWY_FEED_URL} ...`);
    const res = await fetch(CHEWY_FEED_URL);
    if (!res.ok) {
      throw new Error(`Feed download failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }
  console.log(`CHEWY_FEED_URL not set — using mock data at ${MOCK_PATH}`);
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

async function productExists(upc) {
  const { data, error } = await supabase
    .from('products')
    .select('upc')
    .eq('upc', upc)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function run() {
  const feed = await loadFeed();
  console.log(`Loaded ${feed.length} products from feed.\n`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const item of feed) {
    processed += 1;
    try {
      if (!item.upc || !item.name) {
        throw new Error('missing required field (upc or name)');
      }

      const existed = await productExists(item.upc);

      const productRow = {
        upc: item.upc,
        name: item.name,
        brand: item.brand ?? null,
        category: item.category ?? null,
        life_stage: item.life_stage ?? null,
        weight_lbs: item.weight_lbs ?? null,
        image_url: item.image_url ?? null,
        updated_at: new Date().toISOString(),
      };

      const { error: productErr } = await supabase
        .from('products')
        .upsert(productRow, { onConflict: 'upc' });
      if (productErr) throw productErr;

      const priceRow = {
        upc: item.upc,
        store: 'chewy',
        price: item.price,
        autoship_price: item.autoship_price ?? null,
        subscribe_save_price: null,
        in_stock: item.in_stock ?? true,
        affiliate_url: item.affiliate_url ?? null,
        updated_at: new Date().toISOString(),
      };

      const { error: priceErr } = await supabase
        .from('prices')
        .upsert(priceRow, { onConflict: 'upc,store' });
      if (priceErr) throw priceErr;

      if (existed) {
        updated += 1;
        console.log(`  updated  ${item.upc}  ${item.name}`);
      } else {
        inserted += 1;
        console.log(`  inserted ${item.upc}  ${item.name}`);
      }
    } catch (err) {
      errors.push({ upc: item.upc, message: err.message });
      console.error(`  ERROR    ${item.upc}  ${err.message}`);
    }
  }

  console.log('\n--- Import summary ---');
  console.log(`Processed: ${processed}`);
  console.log(`Inserted:  ${inserted}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Errors:    ${errors.length}`);
  if (errors.length) {
    console.log(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

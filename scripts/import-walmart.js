/**
 * import-walmart.js
 *
 * Fetches a Walmart price for every product UPC already in the `products`
 * table and upserts it into `prices` with store = 'walmart'.
 *
 * Walmart has no autoship and no subscribe & save, so those columns are null.
 *
 * Walmart Open API (free, instant approval at https://developer.walmart.com):
 *   GET https://api.walmart.com/v1/items?upc={upc}&apiKey={WALMART_API_KEY}
 *
 * Environment (see .env.example):
 *   SUPABASE_URL                - required
 *   SUPABASE_SERVICE_ROLE_KEY   - required (writes bypass RLS)
 *   WALMART_API_KEY             - required (script exits gracefully if missing)
 *
 * Exit codes: 0 on success (even with per-UPC skips), 1 on fatal error.
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALMART_API_KEY = process.env.WALMART_API_KEY;

// --- graceful credential checks (do not crash) ---------------------------
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}
if (!WALMART_API_KEY) {
  console.error(
    '[ERROR] WALMART_API_KEY is not set in .env — skipping Walmart import.\n' +
      '        Get a free key (instant approval) at https://developer.walmart.com ' +
      "(click 'Get Started' under Open API)."
  );
  process.exit(0); // graceful: nothing to do, but not a crash
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function fetchUpcs() {
  const { data, error } = await supabase.from('products').select('upc');
  if (error) throw error;
  return data.map((r) => r.upc);
}

/**
 * Calls the Walmart Open API for a single UPC and returns the parsed fields,
 * or null if there is no match.
 */
async function fetchWalmartItem(upc) {
  const url = `https://api.walmart.com/v1/items?upc=${encodeURIComponent(
    upc
  )}&apiKey=${encodeURIComponent(WALMART_API_KEY)}`;

  const res = await fetch(url);
  if (res.status === 404) return null; // Walmart returns 404 for unknown UPCs
  if (!res.ok) {
    throw new Error(`Walmart API ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  // The /v1/items endpoint returns an `items` array; a UPC lookup yields 0 or 1.
  const item = Array.isArray(body.items) ? body.items[0] : body;
  if (!item || (item.salePrice == null && item.msrp == null)) return null;

  return {
    price: item.salePrice != null ? item.salePrice : item.msrp,
    affiliate_url: item.productUrl ?? null,
    in_stock: item.availabilityStatus === 'In Stock',
  };
}

async function upsertPrice(upc, parsed) {
  // Detect insert vs update so we can report it accurately.
  const { data: existing, error: selErr } = await supabase
    .from('prices')
    .select('id')
    .eq('upc', upc)
    .eq('store', 'walmart')
    .maybeSingle();
  if (selErr) throw selErr;

  const { error } = await supabase.from('prices').upsert(
    {
      upc,
      store: 'walmart',
      price: parsed.price,
      autoship_price: null, // Walmart has no autoship
      subscribe_save_price: null, // Walmart has no subscribe & save
      in_stock: parsed.in_stock,
      affiliate_url: parsed.affiliate_url,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'upc,store' }
  );
  if (error) throw error;

  return existing ? 'updated' : 'inserted';
}

async function run() {
  const upcs = await fetchUpcs();
  console.log(`[walmart] ${upcs.length} product UPC(s) to look up.\n`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const upc of upcs) {
    processed += 1;
    try {
      const parsed = await fetchWalmartItem(upc);
      if (!parsed) {
        skipped += 1;
        console.log(`[SKIP] No Walmart result for UPC: ${upc}`);
        continue;
      }
      const action = await upsertPrice(upc, parsed);
      if (action === 'inserted') inserted += 1;
      else updated += 1;
      console.log(`[walmart] ${action} ${upc}  $${parsed.price}`);
    } catch (err) {
      errors.push({ upc, message: err.message });
      console.error(`[ERROR] ${upc}: ${err.message}`);
    }
  }

  console.log('\n--- Walmart import summary ---');
  console.log(`Processed: ${processed}`);
  console.log(`Inserted:  ${inserted}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Errors:    ${errors.length}`);
  // Machine-readable line consumed by import-all.js
  console.log(
    '__SUMMARY__ ' +
      JSON.stringify({ store: 'walmart', processed, inserted, updated, skipped, errors: errors.length })
  );
}

run().catch((err) => {
  console.error('[FATAL] walmart import:', err.message);
  process.exit(1);
});

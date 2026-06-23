/**
 * import-petsmart.js
 *
 * Fetches a PetSmart price for every product UPC in the `products` table via
 * the Rainforest API (which can scrape petsmart.com search results) and
 * upserts into `prices` with store = 'petsmart'.
 *
 * Rainforest API:
 *   GET https://api.rainforestapi.com/request
 *       ?api_key={RAINFOREST_API_KEY}
 *       &type=search
 *       &search_term={upc}
 *       &amazon_domain=petsmart.com
 *
 * Environment (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - required
 *   RAINFOREST_API_KEY                        - required ($0.002/request)
 *
 * PetSmart has no autoship / subscribe & save, so those columns are null.
 * Missing key → graceful exit (code 0).
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAINFOREST_API_KEY = process.env.RAINFOREST_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}
if (!RAINFOREST_API_KEY) {
  console.error(
    '[ERROR] RAINFOREST_API_KEY is not set in .env — skipping PetSmart import.\n' +
      '        Get a key (pay as you go, $0.002/request) at https://rainforestapi.com.'
  );
  process.exit(0); // graceful skip
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function fetchUpcs() {
  const { data, error } = await supabase.from('products').select('upc');
  if (error) throw error;
  return data.map((r) => r.upc);
}

/** Calls Rainforest and returns parsed price/url from the first result, or null. */
async function fetchPetsmartItem(upc) {
  const params = new URLSearchParams({
    api_key: RAINFOREST_API_KEY,
    type: 'search',
    search_term: upc,
    amazon_domain: 'petsmart.com',
  });
  const url = `https://api.rainforestapi.com/request?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Rainforest API ${res.status} ${res.statusText}`);
  }
  const body = await res.json();

  const results = body.search_results || [];
  if (results.length === 0) return null;

  const first = results[0];
  // Rainforest exposes price as { value, raw, currency }.
  const price =
    first?.price?.value ??
    (first?.price?.raw
      ? Number(String(first.price.raw).replace(/[^0-9.]/g, ''))
      : null);
  if (price == null || !isFinite(price)) return null;

  return {
    price,
    affiliate_url: first.link || null,
    in_stock: true, // a returned search result implies it is listed/available
  };
}

async function upsertPrice(upc, parsed) {
  const { data: existing, error: selErr } = await supabase
    .from('prices')
    .select('id')
    .eq('upc', upc)
    .eq('store', 'petsmart')
    .maybeSingle();
  if (selErr) throw selErr;

  const { error } = await supabase.from('prices').upsert(
    {
      upc,
      store: 'petsmart',
      price: parsed.price,
      autoship_price: null,
      subscribe_save_price: null,
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
  console.log(`[petsmart] ${upcs.length} product UPC(s) to look up.\n`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const upc of upcs) {
    processed += 1;
    try {
      const parsed = await fetchPetsmartItem(upc);
      if (!parsed) {
        skipped += 1;
        console.log(`[SKIP] No PetSmart result for UPC: ${upc}`);
        continue;
      }
      const action = await upsertPrice(upc, parsed);
      if (action === 'inserted') inserted += 1;
      else updated += 1;
      console.log(`[petsmart] ${action} ${upc}  $${parsed.price}`);
    } catch (err) {
      errors.push({ upc, message: err.message });
      console.error(`[ERROR] ${upc}: ${err.message}`);
    }
  }

  console.log('\n--- PetSmart import summary ---');
  console.log(`Processed: ${processed}`);
  console.log(`Inserted:  ${inserted}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Errors:    ${errors.length}`);
  console.log(
    '__SUMMARY__ ' +
      JSON.stringify({ store: 'petsmart', processed, inserted, updated, skipped, errors: errors.length })
  );
}

run().catch((err) => {
  console.error('[FATAL] petsmart import:', err.message);
  process.exit(1);
});

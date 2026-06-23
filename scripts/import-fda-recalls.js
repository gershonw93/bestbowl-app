/**
 * import-fda-recalls.js
 *
 * Pulls pet-food recall records from the openFDA food enforcement API,
 * keeps the ones whose product_description mentions one of our brands, stores
 * them in the `recalls` table, then updates quality_scores.recall_count for
 * each product based on recalls in the last 5 years.
 *
 *   GET https://api.fda.gov/food/enforcement.json
 *       ?search=product_type:Food+AND+product_description:pet&limit=100&skip=N
 *
 * Env (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - required
 *   OPENFDA_API_KEY                           - optional (raises rate limits)
 *
 * Missing OPENFDA_API_KEY is fine — the API works unauthenticated at a lower
 * rate limit.
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENFDA_API_KEY = process.env.OPENFDA_API_KEY || null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const BASE = 'https://api.fda.gov/food/enforcement.json';
const SEARCH = 'product_type:Food+AND+product_description:pet';
const PAGE = 100;

const FIVE_YEARS_AGO = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d;
})();

/** openFDA dates are YYYYMMDD strings → ISO date or null. */
function parseFdaDate(s) {
  if (!s || s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function loadBrands() {
  const { data, error } = await supabase
    .from('products')
    .select('upc, brand')
    .not('brand', 'is', null);
  if (error) throw error;
  // unique, non-empty brands
  return [...new Set(data.map((r) => r.brand).filter(Boolean))];
}

function matchBrand(description, brands) {
  const d = (description || '').toLowerCase();
  return brands.find((b) => d.includes(b.toLowerCase())) || null;
}

async function fetchPage(skip) {
  const params = new URLSearchParams({ search: SEARCH, limit: String(PAGE), skip: String(skip) });
  if (OPENFDA_API_KEY) params.set('api_key', OPENFDA_API_KEY);
  // SEARCH already contains '+'/':' which URLSearchParams would re-encode, so
  // build the query manually for the search term and append the rest.
  let url = `${BASE}?search=${SEARCH}&limit=${PAGE}&skip=${skip}`;
  if (OPENFDA_API_KEY) url += `&api_key=${OPENFDA_API_KEY}`;

  const res = await fetch(url);
  if (res.status === 404) return { results: [], total: 0 }; // openFDA 404 = no more
  if (!res.ok) throw new Error(`openFDA ${res.status} ${res.statusText}`);
  const body = await res.json();
  return { results: body.results || [], total: body?.meta?.results?.total ?? 0 };
}

async function run() {
  const brands = await loadBrands();
  console.log(`[fda] matching recalls against ${brands.length} brand(s).`);

  // --- paginate through all results ---
  const matched = []; // recall rows that mention one of our brands
  let skip = 0;
  let total = Infinity;
  let scanned = 0;

  while (skip < total) {
    const { results, total: t } = await fetchPage(skip);
    if (skip === 0) {
      total = t || results.length;
      console.log(`[fda] ${total} pet recall record(s) reported by openFDA.`);
    }
    if (results.length === 0) break;

    for (const r of results) {
      scanned += 1;
      const brand = matchBrand(r.product_description, brands);
      if (!brand) continue;
      matched.push({
        brand,
        product_description: r.product_description || null,
        recall_date: parseFdaDate(r.recall_initiation_date),
        reason: r.reason_for_recall || null,
        status: r.status || null,
        recalling_firm: r.recalling_firm || null,
        imported_at: new Date().toISOString(),
      });
    }
    skip += PAGE;
    // openFDA caps skip at 25000; stop politely before that.
    if (skip >= 25000) break;
  }

  // --- replace the recalls table contents with this run's matches ---
  // (delete-all then insert keeps recall_count idempotent across runs.)
  const { error: delErr } = await supabase
    .from('recalls')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) throw delErr;

  if (matched.length) {
    const { error: insErr } = await supabase.from('recalls').insert(matched);
    if (insErr) throw insErr;
  }

  // --- count recalls (last 5 years) per brand and update quality_scores ---
  const countByBrand = new Map();
  for (const rec of matched) {
    const recent =
      !rec.recall_date || new Date(rec.recall_date) >= FIVE_YEARS_AGO;
    if (!recent) continue;
    countByBrand.set(rec.brand, (countByBrand.get(rec.brand) || 0) + 1);
  }

  const { data: products, error: prodErr } = await supabase
    .from('products')
    .select('upc, brand');
  if (prodErr) throw prodErr;

  let updated = 0;
  for (const p of products) {
    const count = countByBrand.get(p.brand) || 0;
    const { error } = await supabase
      .from('quality_scores')
      .update({ recall_count: count })
      .eq('upc', p.upc);
    if (error) throw error;
    updated += 1;
  }

  console.log('\n--- FDA recall import summary ---');
  console.log(`Records scanned:        ${scanned}`);
  console.log(`Matched to our brands:  ${matched.length}`);
  console.log(`quality_scores updated: ${updated}`);
  console.log('Recall counts (last 5 years) by brand:');
  if (countByBrand.size === 0) {
    console.log('  (none of our brands had recalls in the last 5 years)');
  } else {
    for (const [brand, count] of [...countByBrand.entries()].sort()) {
      console.log(`  ${brand}: ${count}`);
    }
  }
}

run().catch((err) => {
  console.error('[FATAL] fda recall import:', err.message);
  process.exit(1);
});

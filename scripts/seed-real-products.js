/**
 * seed-real-products.js
 *
 * Replaces the placeholder catalog with REAL pet-food products pulled from the
 * Rainforest API (Amazon data) and upserts them into `products` + `prices`
 * (store = 'amazon').
 *
 * Two lookup modes (set RAINFOREST_LOOKUP in .env):
 *   - "asin"   (default, per spec) → GET ...&type=product&asin={asin}
 *   - "search"                     → GET ...&type=search&search_term={query}
 *                                    (uses the first result — handy when an
 *                                     ASIN is unknown/stale; same 1 credit each)
 *
 * CREDIT SAFETY:
 *   - Each API call costs 1 Rainforest credit (even "product not found").
 *   - SEED_LIMIT caps how many products are processed (default 20).
 *   - A 2-second delay separates calls.
 *   - The hardcoded ASINs are best-effort and SHOULD be verified on amazon.com
 *     before a large run; if many come back "not found", switch to search mode.
 *
 * Env (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - required (writes bypass RLS)
 *   RAINFOREST_API_KEY                        - required
 *   RAINFOREST_LOOKUP                         - "asin" (default) | "search"
 *   SEED_LIMIT                                - default 20
 *   AMAZON_PARTNER_TAG                        - optional, appended to affiliate URLs
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAINFOREST_API_KEY = process.env.RAINFOREST_API_KEY;
const LOOKUP = (process.env.RAINFOREST_LOOKUP || 'asin').toLowerCase();
const LIMIT = process.env.SEED_LIMIT ? parseInt(process.env.SEED_LIMIT, 10) : 20;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || null;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env.');
  process.exit(1);
}
if (!RAINFOREST_API_KEY) {
  console.error('[ERROR] RAINFOREST_API_KEY is not set in .env. Get a key at https://rainforestapi.com');
  process.exit(0); // graceful
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 50 real, popular pet-food products. `asin` = best-effort Amazon ASIN (VERIFY
// before a big run, or use RAINFOREST_LOOKUP=search). `query` is the search
// fallback. category/life_stage are curated (the API doesn't return clean
// values for these); title/brand/price/image/upc come from the API.
// ---------------------------------------------------------------------------
const PRODUCTS = [
  // ---- Purina Pro Plan ----
  { asin: 'B01N9KSITZ', query: 'Purina Pro Plan Sensitive Skin Stomach Salmon Rice dry dog food', brand: 'Purina Pro Plan', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0019CW0HE', query: 'Purina Pro Plan Adult Shredded Blend Chicken Rice dry dog food', brand: 'Purina Pro Plan', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0019CW0HE', query: 'Purina Pro Plan Complete Essentials Chicken Rice dry cat food', brand: 'Purina Pro Plan', category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B08JTYYV5V', query: 'Purina Pro Plan Focus Kitten chicken wet cat food', brand: 'Purina Pro Plan', category: 'cat_wet', life_stage: 'puppy' },
  { asin: 'B07ZPG5CWJ', query: 'Purina Pro Plan Puppy chicken rice dry dog food', brand: 'Purina Pro Plan', category: 'dog_dry', life_stage: 'puppy' },

  // ---- Blue Buffalo ----
  { asin: 'B0009YWBP6', query: 'Blue Buffalo Life Protection Formula Adult Chicken Brown Rice dry dog food', brand: 'Blue Buffalo', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B01M5JZ7HV', query: 'Blue Buffalo Wilderness High Protein Chicken dry dog food', brand: 'Blue Buffalo', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0017JG36S', query: 'Blue Buffalo Indoor Health Chicken Brown Rice dry cat food', brand: 'Blue Buffalo', category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B003VWNBL8', query: 'Blue Buffalo Wilderness Chicken wet cat food pate', brand: 'Blue Buffalo', category: 'cat_wet', life_stage: 'adult' },
  { asin: 'B0009YJ8XO', query: 'Blue Buffalo Life Protection Puppy Chicken Brown Rice dry dog food', brand: 'Blue Buffalo', category: 'dog_dry', life_stage: 'puppy' },

  // ---- Hill's Science Diet ----
  { asin: 'B07JKMHGK8', query: "Hill's Science Diet Adult Chicken Barley dry dog food", brand: "Hill's Science Diet", category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0716W9PND', query: "Hill's Science Diet Sensitive Stomach Skin chicken dry dog food", brand: "Hill's Science Diet", category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0058XEQ0M', query: "Hill's Science Diet Adult Indoor chicken dry cat food", brand: "Hill's Science Diet", category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B074JZX4ZH', query: "Hill's Science Diet Adult 7+ chicken wet cat food", brand: "Hill's Science Diet", category: 'cat_wet', life_stage: 'senior' },
  { asin: 'B0058XEQ8O', query: "Hill's Science Diet Puppy chicken barley dry dog food", brand: "Hill's Science Diet", category: 'dog_dry', life_stage: 'puppy' },

  // ---- Royal Canin ----
  { asin: 'B0058XEQ1G', query: 'Royal Canin Feline Health Nutrition Indoor Adult dry cat food', brand: 'Royal Canin', category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B00P4D2JGW', query: 'Royal Canin Medium Adult dry dog food', brand: 'Royal Canin', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B07D5R7RXJ', query: 'Royal Canin Kitten Thin Slices Gravy wet cat food', brand: 'Royal Canin', category: 'cat_wet', life_stage: 'puppy' },
  { asin: 'B0058XESV2', query: 'Royal Canin Small Puppy dry dog food', brand: 'Royal Canin', category: 'dog_dry', life_stage: 'puppy' },
  { asin: 'B00P4D2HJC', query: 'Royal Canin Indoor 7+ senior dry cat food', brand: 'Royal Canin', category: 'cat_dry', life_stage: 'senior' },

  // ---- Orijen ----
  { asin: 'B086R3GS2P', query: 'Orijen Original grain-free dry dog food', brand: 'Orijen', category: 'dog_dry', life_stage: 'all_life_stages' },
  { asin: 'B086R59Z2F', query: 'Orijen Six Fish grain-free dry dog food', brand: 'Orijen', category: 'dog_dry', life_stage: 'all_life_stages' },
  { asin: 'B086R3J8YK', query: 'Orijen Cat Tundra grain-free dry cat food', brand: 'Orijen', category: 'cat_dry', life_stage: 'all_life_stages' },
  { asin: 'B086R4F8N9', query: 'Orijen Puppy grain-free dry dog food', brand: 'Orijen', category: 'dog_dry', life_stage: 'puppy' },
  { asin: 'B086R3GH4M', query: 'Orijen Original grain-free dry cat food', brand: 'Orijen', category: 'cat_dry', life_stage: 'all_life_stages' },

  // ---- Acana ----
  { asin: 'B0815H5R8J', query: 'Acana Wild Atlantic grain-free dry cat food', brand: 'Acana', category: 'cat_dry', life_stage: 'all_life_stages' },
  { asin: 'B0815H9R8J', query: 'Acana Wild Prairie grain-free dry dog food', brand: 'Acana', category: 'dog_dry', life_stage: 'all_life_stages' },
  { asin: 'B0815G7TPP', query: 'Acana Free-Run Poultry dry dog food', brand: 'Acana', category: 'dog_dry', life_stage: 'all_life_stages' },
  { asin: 'B0815H2K9R', query: 'Acana Indoor Entree dry cat food', brand: 'Acana', category: 'cat_dry', life_stage: 'all_life_stages' },
  { asin: 'B0815GKL4T', query: 'Acana Puppy Recipe dry dog food', brand: 'Acana', category: 'dog_dry', life_stage: 'puppy' },

  // ---- Merrick ----
  { asin: 'B00DTL3XS2', query: 'Merrick Grain-Free Real Beef Sweet Potato dry dog food', brand: 'Merrick', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B00DTL3W9M', query: 'Merrick Grain-Free Real Chicken Sweet Potato dry dog food', brand: 'Merrick', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B019HRRG9C', query: 'Merrick Purrfect Bistro grain-free chicken dry cat food', brand: 'Merrick', category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B00DTL3YQ8', query: 'Merrick Grain-Free wet dog food real beef', brand: 'Merrick', category: 'dog_wet', life_stage: 'adult' },
  { asin: 'B019HRRGB0', query: 'Merrick Purrfect Bistro grain-free wet cat food', brand: 'Merrick', category: 'cat_wet', life_stage: 'adult' },

  // ---- Wellness ----
  { asin: 'B0009YEP24', query: 'Wellness Complete Health Adult Deboned Chicken Oatmeal dry dog food', brand: 'Wellness', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0019RFNV6', query: 'Wellness Complete Health Adult Deboned Chicken dry cat food', brand: 'Wellness', category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B0019RFNW0', query: 'Wellness CORE grain-free original dry dog food', brand: 'Wellness', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0009YEP2E', query: 'Wellness Complete Health wet cat food chicken pate', brand: 'Wellness', category: 'cat_wet', life_stage: 'adult' },
  { asin: 'B0019RFNX4', query: 'Wellness Complete Health Puppy deboned chicken dry dog food', brand: 'Wellness', category: 'dog_dry', life_stage: 'puppy' },

  // ---- Taste of the Wild ----
  { asin: 'B0035UPNI4', query: 'Taste of the Wild High Prairie grain-free dry dog food', brand: 'Taste of the Wild', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0035UPNII', query: 'Taste of the Wild Pacific Stream grain-free dry dog food', brand: 'Taste of the Wild', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B0035UPNJW', query: 'Taste of the Wild Rocky Mountain grain-free dry cat food', brand: 'Taste of the Wild', category: 'cat_dry', life_stage: 'all_life_stages' },
  { asin: 'B0035UPNKG', query: 'Taste of the Wild High Prairie Puppy grain-free dry dog food', brand: 'Taste of the Wild', category: 'dog_dry', life_stage: 'puppy' },
  { asin: 'B0035UPNL0', query: 'Taste of the Wild Canyon River grain-free dry cat food', brand: 'Taste of the Wild', category: 'cat_dry', life_stage: 'all_life_stages' },

  // ---- Iams ----
  { asin: 'B07TZHZX9P', query: 'Iams Proactive Health Adult MiniChunks chicken dry dog food', brand: 'Iams', category: 'dog_dry', life_stage: 'adult' },
  { asin: 'B07TZ8YX2C', query: 'Iams Proactive Health Indoor Weight Hairball dry cat food', brand: 'Iams', category: 'cat_dry', life_stage: 'adult' },
  { asin: 'B07TZJ6V8S', query: 'Iams Proactive Health Healthy Adult chicken wet cat food', brand: 'Iams', category: 'cat_wet', life_stage: 'adult' },
  { asin: 'B07TZ9C4QH', query: 'Iams Proactive Health Smart Puppy chicken dry dog food', brand: 'Iams', category: 'dog_dry', life_stage: 'puppy' },
  { asin: 'B07TZ7N4ML', query: 'Iams Proactive Health Senior chicken dry dog food', brand: 'Iams', category: 'dog_dry', life_stage: 'senior' },
];

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function findUpc(product) {
  // Rainforest puts identifiers under specifications / attributes; scan for UPC/GTIN/EAN.
  const buckets = [].concat(product.specifications || [], product.attributes || []);
  for (const s of buckets) {
    if (s && /upc|gtin|ean/i.test(s.name || '') && s.value) {
      const v = String(s.value).replace(/[^0-9]/g, '');
      if (v.length >= 8) return v;
    }
  }
  return null;
}

/** One Rainforest call (1 credit) → normalized product fields, or null. */
async function lookup(entry) {
  const base = `https://api.rainforestapi.com/request?api_key=${encodeURIComponent(RAINFOREST_API_KEY)}&amazon_domain=amazon.com`;
  const url =
    LOOKUP === 'search'
      ? `${base}&type=search&search_term=${encodeURIComponent(entry.query)}`
      : `${base}&type=product&asin=${encodeURIComponent(entry.asin)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Rainforest HTTP ${res.status}`);
  const body = await res.json();

  if (LOOKUP === 'search') {
    const first = (body.search_results || [])[0];
    if (!first) return null;
    return {
      asin: first.asin,
      title: first.title,
      brand: entry.brand,
      price: first.price ? num(first.price.value ?? first.price.raw) : null,
      image: first.image || null,
      upc: null, // search results don't include UPC; product key falls back to ASIN
      link: first.link || `https://www.amazon.com/dp/${first.asin}`,
      in_stock: true,
    };
  }

  const p = body.product;
  if (!p || !p.asin) return null;
  const bb = p.buybox_winner || {};
  return {
    asin: p.asin,
    title: p.title,
    brand: (p.brand || entry.brand),
    price: bb.price ? num(bb.price.value ?? bb.price.raw) : (p.price ? num(p.price.value) : null),
    image: (p.main_image && p.main_image.link) || (p.images && p.images[0] && p.images[0].link) || null,
    upc: findUpc(p),
    link: p.link || `https://www.amazon.com/dp/${p.asin}`,
    in_stock: bb.availability ? !/unavailable|out of stock/i.test(bb.availability.raw || '') : true,
  };
}

async function run() {
  const list = PRODUCTS.slice(0, LIMIT);
  console.log(`BestBowl real-product seed`);
  console.log(`  lookup mode : ${LOOKUP}`);
  console.log(`  processing  : ${list.length} of ${PRODUCTS.length} products (SEED_LIMIT=${LIMIT})`);
  console.log(`  credit cost : ~${list.length} Rainforest credit(s), 1 per product\n`);

  let processed = 0, upserted = 0, skipped = 0;
  const errors = [];

  for (const entry of list) {
    processed += 1;
    const label = `${entry.brand} (${LOOKUP === 'asin' ? entry.asin : entry.query.slice(0, 40)})`;
    try {
      const d = await lookup(entry);
      if (!d || !d.title) {
        skipped += 1;
        console.log(`[SKIP] ${processed}/${list.length} not found: ${label}`);
      } else {
        const upc = d.upc || d.asin; // real UPC if present, else the ASIN as a stable key
        const affiliate = PARTNER_TAG ? `${d.link}${d.link.includes('?') ? '&' : '?'}tag=${PARTNER_TAG}` : d.link;

        const { error: prodErr } = await supabase.from('products').upsert({
          upc,
          name: d.title,
          brand: d.brand,
          category: entry.category,
          life_stage: entry.life_stage,
          image_url: d.image,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'upc' });
        if (prodErr) throw prodErr;

        if (d.price != null) {
          const { error: priceErr } = await supabase.from('prices').upsert({
            upc,
            store: 'amazon',
            price: d.price,
            autoship_price: null,
            subscribe_save_price: null,
            in_stock: d.in_stock,
            affiliate_url: affiliate,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'upc,store' });
          if (priceErr) throw priceErr;
        }

        upserted += 1;
        console.log(`[OK]   ${processed}/${list.length} ${d.title.slice(0, 54)}  $${d.price ?? '—'}  (${upc})`);
      }
    } catch (err) {
      errors.push({ label, message: err.message });
      console.error(`[ERR]  ${processed}/${list.length} ${label}: ${err.message}`);
    }
    if (processed < list.length) await sleep(2000); // 2s between calls to preserve credits
  }

  console.log('\n--- Seed summary ---');
  console.log(`Processed (credits used): ${processed}`);
  console.log(`Upserted:                 ${upserted}`);
  console.log(`Not found / skipped:      ${skipped}`);
  console.log(`Errors:                   ${errors.length}`);
  if (skipped > 0 && LOOKUP === 'asin') {
    console.log('\nTip: some ASINs were not found. Set RAINFOREST_LOOKUP=search in .env to resolve those by name instead.');
  }
}

run().catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });

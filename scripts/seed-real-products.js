/**
 * seed-real-products.js
 *
 * Seeds REAL pet-food products into Supabase by pulling Amazon BEST SELLERS for
 * the dog-food and cat-food categories via the Rainforest API — only TWO
 * credits total (one request per category), each returning the top products
 * with real ASINs, prices, and images.
 *
 * Usable two ways:
 *   - CLI:    `npm run seed:real`
 *   - Module: `const { seed } = require('./seed-real-products'); await seed(opts)`
 *             (used by api/seed-products.js so the browser can trigger it)
 *
 *   GET https://api.rainforestapi.com/request
 *       ?api_key={KEY}&type=bestsellers&url={category_url}&amazon_domain=amazon.com
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAINFOREST_API_KEY,
 *      SEED_LIMIT (top-N per category, default 20), AMAZON_PARTNER_TAG (optional).
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Amazon best-seller category pages (one Rainforest credit each).
const CATEGORIES = [
  { pet: 'dog', url: 'https://www.amazon.com/Best-Sellers-Pet-Supplies-Dog-Food/zgbs/pet-supplies/2975359011' },
  { pet: 'cat', url: 'https://www.amazon.com/Best-Sellers-Pet-Supplies-Cat-Food/zgbs/pet-supplies/2975265011' },
];

// Known brands (longest/most-specific first) for tidy brand extraction from titles.
const KNOWN_BRANDS = [
  'Purina Pro Plan', 'Purina ONE', 'Taste of the Wild', "Hill's Science Diet", "Hill's",
  'Blue Buffalo', 'Royal Canin', 'Rachael Ray Nutrish', 'American Journey', 'Fancy Feast',
  'Meow Mix', 'Nutro', 'Pedigree', 'Friskies', 'Sheba', 'Greenies', 'Cesar', 'Nulo',
  'Instinct', 'Merrick', 'Wellness', 'Orijen', 'Acana', 'Iams', 'Diamond', 'Crave',
  'Kirkland', 'Whiskas', 'Temptations', 'Purina',
];

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function brandOf(title) {
  const t = title || '';
  const hit = KNOWN_BRANDS.find((b) => t.toLowerCase().includes(b.toLowerCase()));
  if (hit) return hit;
  return t.split(/[\s,]+/).slice(0, 2).join(' ') || null; // fallback: first two words
}

function foodTypeOf(title) {
  const t = (title || '').toLowerCase();
  if (/\b(treat|treats|biscuit|jerky|chew|dental|stick|bone)\b/.test(t)) return 'treat';
  if (/\b(wet|can|canned|pate|pâté|gravy|stew|broth|morsels|chunks in|in sauce|loaf|minced)\b/.test(t)) return 'wet';
  return 'dry';
}

function lifeStageOf(title) {
  const t = (title || '').toLowerCase();
  if (/\b(puppy|kitten)\b/.test(t)) return 'puppy';
  if (/\b(senior|mature|aging|7\+|11\+)\b/.test(t)) return 'senior';
  if (/all life stages|all-life-stages|all stages/.test(t)) return 'all_life_stages';
  return 'adult';
}

async function fetchBestsellers(apiKey, url, log) {
  // URLSearchParams guarantees the category `url` (and everything else) is
  // properly percent-encoded in the query string.
  const params = new URLSearchParams({
    api_key: apiKey,
    type: 'bestsellers',
    url, // e.g. https://www.amazon.com/Best-Sellers-.../zgbs/pet-supplies/2975359011
    amazon_domain: 'amazon.com',
  });
  const reqUrl = `https://api.rainforestapi.com/request?${params.toString()}`;

  // Log the exact URL being sent, with the API key redacted.
  const redacted = reqUrl
    .replace(encodeURIComponent(apiKey), 'REDACTED')
    .replace(apiKey, 'REDACTED');
  if (log) log(`[req] GET ${redacted}`);

  const res = await fetch(reqUrl);
  const text = await res.text(); // read body once, as text, so we can log raw errors

  if (!res.ok) {
    const snippet = text.slice(0, 600);
    if (log) log(`[err] Rainforest HTTP ${res.status} body: ${snippet}`);
    throw new Error(`Rainforest HTTP ${res.status}: ${snippet}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (_e) {
    if (log) log(`[err] Rainforest returned non-JSON: ${text.slice(0, 300)}`);
    throw new Error('Rainforest returned non-JSON response');
  }
  const list = body.bestsellers || [];
  if (log) log(`[res] ${res.status} OK — ${list.length} bestsellers in payload`);
  return list;
}

/**
 * Core seeding logic, reusable from CLI and the Vercel function.
 * Returns a summary object; emits progress via opts.log.
 */
async function seed(opts = {}) {
  const cfg = {
    perCategory: opts.perCategory != null ? opts.perCategory : (process.env.SEED_LIMIT ? parseInt(process.env.SEED_LIMIT, 10) : 20),
    apiKey: opts.apiKey || process.env.RAINFOREST_API_KEY,
    supabaseUrl: opts.supabaseUrl || process.env.SUPABASE_URL,
    supabaseKey: opts.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
    partnerTag: opts.partnerTag || process.env.AMAZON_PARTNER_TAG || null,
    delayMs: opts.delayMs != null ? opts.delayMs : 2000,
    log: opts.log || ((m) => console.log(m)),
  };
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if (!cfg.apiKey) throw new Error('Missing RAINFOREST_API_KEY');

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });

  cfg.log(`BestBowl real-product seed — Amazon best sellers, top ${cfg.perCategory}/category, ${CATEGORIES.length} credits total`);

  let creditsUsed = 0, upserted = 0, skipped = 0;
  const errors = [];
  const items = [];
  const perCat = [];

  for (let ci = 0; ci < CATEGORIES.length; ci++) {
    const cat = CATEGORIES[ci];
    let list = [];
    try {
      list = await fetchBestsellers(cfg.apiKey, cat.url, cfg.log);
      creditsUsed += 1;
    } catch (err) {
      errors.push({ category: cat.pet, message: err.message });
      cfg.log(`[ERR] ${cat.pet} bestsellers: ${err.message}`);
      perCat.push({ pet: cat.pet, count: 0 });
      continue;
    }

    const top = list.slice(0, cfg.perCategory);
    cfg.log(`[${cat.pet}] ${top.length} best sellers fetched`);
    let catCount = 0;

    for (const prod of top) {
      const asin = prod.asin;
      if (!asin || !prod.title) { skipped += 1; continue; }
      try {
        const title = prod.title;
        const price = prod.price ? num(prod.price.value ?? prod.price.raw) : null;
        const category = `${cat.pet}_${foodTypeOf(title)}`;
        const link = prod.link || `https://www.amazon.com/dp/${asin}`;
        const affiliate = cfg.partnerTag ? `${link}${link.includes('?') ? '&' : '?'}tag=${cfg.partnerTag}` : link;

        const { error: prodErr } = await supabase.from('products').upsert({
          upc: asin,                       // ASINs are real + unique; used as the key
          name: title,
          brand: prod.brand || brandOf(title),
          category,
          life_stage: lifeStageOf(title),
          image_url: prod.image || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'upc' });
        if (prodErr) throw prodErr;

        if (price != null) {
          const { error: priceErr } = await supabase.from('prices').upsert({
            upc: asin, store: 'amazon', price,
            autoship_price: null, subscribe_save_price: null,
            in_stock: true, affiliate_url: affiliate, updated_at: new Date().toISOString(),
          }, { onConflict: 'upc,store' });
          if (priceErr) throw priceErr;
        }

        upserted += 1; catCount += 1;
        items.push({ status: 'ok', pet: cat.pet, asin, name: title, brand: prod.brand || brandOf(title), category, price });
        cfg.log(`[OK] ${cat.pet} ${String(title).slice(0, 56)}  $${price ?? '—'}  (${asin})`);
      } catch (err) {
        errors.push({ asin, message: err.message });
        items.push({ status: 'error', asin, message: err.message });
        cfg.log(`[ERR] ${asin}: ${err.message}`);
      }
    }
    perCat.push({ pet: cat.pet, count: catCount });
    if (ci < CATEGORIES.length - 1) await sleep(cfg.delayMs);
  }

  cfg.log(`Done — ${creditsUsed} credit(s) used, ${upserted} upserted, ${skipped} skipped, ${errors.length} errors`);
  return { creditsUsed, categories: perCat, upserted, skipped, errors: errors.length, items };
}

if (require.main === module) {
  seed()
    .then((r) => { if (r.errors > 0) process.exit(1); })
    .catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
}

module.exports = { seed, CATEGORIES };

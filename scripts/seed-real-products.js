/**
 * seed-real-products.js
 *
 * Seeds REAL pet-food products into Supabase by pulling Amazon BEST SELLERS for
 * the dog/cat food + treat categories via the Rainforest API — one credit per
 * category (4 categories = 4 credits), each returning the top products with
 * real ASINs, prices, and images.
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
  { pet: 'dog', foodType: 'treat', url: 'https://www.amazon.com/Best-Sellers-Pet-Supplies-Dog-Treats/zgbs/pet-supplies/2975434011' },
  { pet: 'cat', foodType: 'treat', url: 'https://www.amazon.com/Best-Sellers-Pet-Supplies-Cat-Treats/zgbs/pet-supplies/2975309011' },
];

// Chewy + Walmart category searches (one Rainforest credit each, 8 total).
// NOTE: Rainforest is an Amazon-focused API; non-Amazon `url`s may be rejected —
// the per-search error logging makes that obvious when the phase runs.
const STORE_SEARCHES = [
  { store: 'chewy', url: 'https://www.chewy.com/s?query=dry+dog+food' },
  { store: 'chewy', url: 'https://www.chewy.com/s?query=wet+dog+food' },
  { store: 'chewy', url: 'https://www.chewy.com/s?query=dry+cat+food' },
  { store: 'chewy', url: 'https://www.chewy.com/s?query=cat+treats' },
  { store: 'chewy', url: 'https://www.chewy.com/s?query=dog+treats' },
  { store: 'walmart', url: 'https://www.walmart.com/search?q=dry+dog+food' },
  { store: 'walmart', url: 'https://www.walmart.com/search?q=dry+cat+food' },
  { store: 'walmart', url: 'https://www.walmart.com/search?q=dog+treats' },
];

// --- fuzzy product matching (same approach as the OPFF importer) -------------
// Tokens we ignore when scoring name overlap so generic words don't inflate it.
const STOP = new Set([
  'grain', 'free', 'adult', 'puppy', 'kitten', 'senior', 'dry', 'wet', 'food',
  'formula', 'recipe', 'with', 'and', 'the', 'for', 'dog', 'dogs', 'cat', 'cats',
  'natural', 'health', 'complete', 'nutrition', 'lb', 'lbs', 'oz', 'pet', 'count',
  'pack', 'ct', 'bag', 'can', 'cans', 'pouch', 'tub',
]);
const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nameTokens = (s) => normName(s).split(' ').filter((t) => t && !STOP.has(t));
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  return inter / new Set([...a, ...b]).size;
}
// Fuzzy brand agreement — substring either way, or >=0.5 token Jaccard.
function brandMatches(brandA, brandB) {
  const a = normName(brandA), b = normName(brandB);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return jaccard(nameTokens(a), nameTokens(b)) >= 0.5;
}
// Best product for a store result: name-token Jaccard >= 0.5, brand not contradicting.
function bestMatch(title, products) {
  const rb = brandOf(title);
  const tks = nameTokens(title);
  let best = null, bestScore = 0;
  for (const p of products) {
    const score = jaccard(tks, nameTokens(p.name));
    if (score < 0.5) continue;
    if (rb && p.brand && !brandMatches(p.brand, rb)) continue; // brand guard
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best ? { product: best, score: bestScore } : null;
}

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

// --- pack size (oz) + flavor parsing, so a price row can show $/oz and label
// its flavor (mirrors the logic in import-impact-chewy.js). Amazon best-seller
// titles are often truncated by the feed, so size is frequently unknown here. ---
function sizeOz(name) {
  const t = String(name || '').toLowerCase();
  let m;
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:lb\b|lbs\b|pound)/))) return parseFloat(m[1]) * 16;
  const oz = (m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:oz\b|ounce)/)) ? parseFloat(m[1]) : null;
  if (oz == null) return null;
  let cnt = null;
  if ((m = t.match(/(?:case|pack|count)\s*of\s*(\d+)/))) cnt = parseInt(m[1], 10);
  else if ((m = t.match(/(\d+)\s*-?\s*(?:ct\b|count\b|packs?\b|cans?\b|pouch(?:es)?\b|tubs?\b|sticks?\b|pieces?\b)/))) cnt = parseInt(m[1], 10);
  return oz * (cnt || 1);
}
const PROTEINS = ['chicken', 'turkey', 'beef', 'salmon', 'whitefish', 'tuna', 'lamb', 'duck',
  'venison', 'rabbit', 'pork', 'bison', 'trout', 'herring', 'mackerel', 'sardine', 'cod', 'liver'];
const FLAVOR_WORDS = ['catnip', 'dairy', 'cheese', 'cheddar', 'pumpkin', 'bacon', 'peanut',
  'seafood', 'shrimp', 'crab', 'lobster', 'sweet potato', 'blueberry', 'apple', 'carrot',
  'cranberry', 'honey', 'vanilla', 'egg', 'catfish'];
function flavorOf(name) {
  const t = String(name || '').toLowerCase();
  let best = null, bestIdx = Infinity;
  for (const p of PROTEINS) { const i = t.indexOf(p); if (i >= 0 && i < bestIdx) { bestIdx = i; best = p; } }
  if (best) return best;
  for (const f of FLAVOR_WORDS) { if (t.includes(f)) return f; }
  return null;
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
  // NOTE: `amazon_domain` must NOT be combined with `url` — Rainforest rejects
  // that with HTTP 400. The url already defines the domain.
  const params = new URLSearchParams({
    api_key: apiKey,
    type: 'bestsellers',
    url, // e.g. https://www.amazon.com/Best-Sellers-.../zgbs/pet-supplies/2975359011
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
  if (log) {
    log(`[res] ${res.status} OK — ${list.length} bestsellers in payload`);
    if (list[0]) {
      // Confirm the exact image field shape on the first result.
      log(`[image] first result: image=${JSON.stringify(list[0].image)} main_image=${JSON.stringify(list[0].main_image)}`);
    }
  }
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
        // Bestsellers returns `image` as a string URL; fall back to object
        // forms (image.link / main_image.link) just in case the shape varies.
        const image =
          (typeof prod.image === 'string' && prod.image) ||
          (prod.image && prod.image.link) ||
          (prod.main_image && prod.main_image.link) ||
          null;
        // Treat categories force the type; others infer dry/wet/treat from the title.
        const category = `${cat.pet}_${cat.foodType || foodTypeOf(title)}`;
        // Canonical affiliate URL: amazon.com/dp/{asin}?tag={partner tag}
        const tag = cfg.partnerTag || 'bestbowl0a-20';
        const affiliate = `https://www.amazon.com/dp/${asin}?tag=${tag}`;

        const { error: prodErr } = await supabase.from('products').upsert({
          upc: asin,                       // ASINs are real + unique; used as the key
          name: title,
          brand: prod.brand || brandOf(title),
          category,
          life_stage: lifeStageOf(title),
          image_url: image,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'upc' });
        if (prodErr) throw prodErr;

        if (price != null) {
          const { error: priceErr } = await supabase.from('prices').upsert({
            upc: asin, store: 'amazon', price,
            autoship_price: null, subscribe_save_price: null,
            in_stock: true, affiliate_url: affiliate,
            pack_size_oz: sizeOz(title), flavor: flavorOf(title),
            updated_at: new Date().toISOString(),
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

// --- Phase 2: Chewy + Walmart prices via Rainforest `type=search` -----------
async function fetchSearch(apiKey, url, log) {
  const params = new URLSearchParams({ api_key: apiKey, type: 'search', url });
  const reqUrl = `https://api.rainforestapi.com/request?${params.toString()}`;
  const redacted = reqUrl.replace(encodeURIComponent(apiKey), 'REDACTED').replace(apiKey, 'REDACTED');
  if (log) log(`[req] GET ${redacted}`);

  const res = await fetch(reqUrl);
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 600);
    if (log) log(`[err] Rainforest HTTP ${res.status} body: ${snippet}`);
    throw new Error(`Rainforest HTTP ${res.status}: ${snippet}`);
  }
  let body;
  try { body = JSON.parse(text); }
  catch (_e) { if (log) log(`[err] Rainforest returned non-JSON: ${text.slice(0, 300)}`); throw new Error('Rainforest returned non-JSON response'); }
  const list = body.search_results || [];
  if (log) {
    log(`[res] ${res.status} OK — ${list.length} search results`);
    if (list[0]) log(`[shape] first: title=${JSON.stringify(String(list[0].title || '').slice(0, 40))} price=${JSON.stringify(list[0].price)} link=${JSON.stringify(list[0].link || list[0].url)}`);
  }
  return list;
}

/**
 * Phase 2 — pull Chewy + Walmart category searches and attach their prices to
 * products we already have, matched by fuzzy product-name / brand similarity.
 * 8 searches = 8 Rainforest credits. Returns a summary; emits progress via log.
 */
async function seedStores(opts = {}) {
  const cfg = {
    apiKey: opts.apiKey || process.env.RAINFOREST_API_KEY,
    supabaseUrl: opts.supabaseUrl || process.env.SUPABASE_URL,
    supabaseKey: opts.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
    log: opts.log || ((m) => console.log(m)),
  };
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if (!cfg.apiKey) throw new Error('Missing RAINFOREST_API_KEY');

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });
  cfg.log(`BestBowl store-price seed — Chewy + Walmart searches, ${STORE_SEARCHES.length} credits total`);

  const { data: products, error: pErr } = await supabase.from('products').select('upc,name,brand');
  if (pErr) throw pErr;
  cfg.log(`[stores] ${products.length} existing products loaded for matching`);

  let creditsUsed = 0, matched = 0, missed = 0;
  const errors = [];
  const perStore = {};

  // Fetch all 8 searches in parallel so the whole phase fits in one request.
  const settled = await Promise.all(STORE_SEARCHES.map(async (s) => {
    try { return { s, results: await fetchSearch(cfg.apiKey, s.url, cfg.log) }; }
    catch (err) { errors.push({ url: s.url, message: err.message }); cfg.log(`[ERR] ${s.store} search ${s.url}: ${err.message}`); return { s, results: null }; }
  }));

  for (const { s, results } of settled) {
    perStore[s.store] = perStore[s.store] || { matched: 0, missed: 0 };
    if (!results) continue;
    creditsUsed += 1;
    cfg.log(`[${s.store}] ${results.length} results for ${s.url}`);

    for (const r of results) {
      const name = r.title;
      if (!name) continue;
      const price = r.price ? num(r.price.value ?? r.price.raw) : null;
      const url = r.link || r.url || null;
      const m = bestMatch(name, products);
      if (!m) { missed += 1; perStore[s.store].missed += 1; cfg.log(`[${s.store}] miss  "${String(name).slice(0, 60)}"`); continue; }
      try {
        const { error } = await supabase.from('prices').upsert({
          upc: m.product.upc, store: s.store, price,
          autoship_price: null, subscribe_save_price: null,
          in_stock: true, affiliate_url: url, updated_at: new Date().toISOString(),
        }, { onConflict: 'upc,store' });
        if (error) throw error;
        matched += 1; perStore[s.store].matched += 1;
        cfg.log(`[${s.store}] MATCH "${String(name).slice(0, 46)}" -> ${String(m.product.name).slice(0, 38)}  $${price ?? '—'}  (j=${m.score.toFixed(2)})`);
      } catch (err) {
        errors.push({ name, message: err.message });
        cfg.log(`[ERR] upsert ${s.store} ${m.product.upc}: ${err.message}`);
      }
    }
  }

  cfg.log(`Done — ${creditsUsed} credit(s) used, ${matched} matched, ${missed} missed, ${errors.length} errors`);
  return { creditsUsed, matched, missed, perStore, errors: errors.length };
}

if (require.main === module) {
  const phase = process.argv[2]; // optional: "stores" or "amazon"
  const run = phase === 'stores' ? seedStores() : phase === 'amazon' ? seed() : seed().then((a) => seedStores().then((b) => ({ amazon: a, stores: b })));
  Promise.resolve(run)
    .then((r) => { if (r && r.errors > 0) process.exit(1); })
    .catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
}

module.exports = { seed, seedStores, CATEGORIES, STORE_SEARCHES, bestMatch, brandOf, foodTypeOf, lifeStageOf };

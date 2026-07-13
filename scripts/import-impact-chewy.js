/**
 * import-impact-chewy.js
 *
 * Imports REAL Chewy prices + tracking links from the Impact.com Product Catalog
 * (Chewy's affiliate data feed) and attaches them to products we already have,
 * matched by fuzzy product-name / brand similarity (same logic as the seed).
 *
 * Because the Impact catalog `Url` is already a tracked deep link, matched rows
 * get a ready-to-earn Chewy affiliate_url — no separate link-wrapping needed.
 *
 * Usable two ways:
 *   - CLI:    `node scripts/import-impact-chewy.js`
 *   - Module: `const { importChewy } = require('./import-impact-chewy'); await importChewy(opts)`
 *             (used by api/seed-products.js via ?phase=chewy)
 *
 * Env (see .env.example):
 *   IMPACT_ACCOUNT_SID       - Impact Account SID (Settings → API)
 *   IMPACT_AUTH_TOKEN        - Impact Auth Token  (Settings → API) — secret
 *   IMPACT_CHEWY_CATALOG_ID  - the Chewy catalog id. If unset, the script runs in
 *                              DISCOVERY mode and just lists your catalogs so you
 *                              can find the id.
 *   IMPACT_MAX_ITEMS         - optional cap on catalog items scanned (default 3000)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { bestMatch, brandOf, foodTypeOf, lifeStageOf } = require('./seed-real-products.js');

// Category searches for adding Chewy-only products (ones our Amazon seed lacks).
const EXTRA_SEARCHES = [
  { pet: 'dog', foodType: 'dry', q: 'dry dog food' },
  { pet: 'dog', foodType: 'wet', q: 'wet dog food' },
  { pet: 'cat', foodType: 'dry', q: 'dry cat food' },
  { pet: 'cat', foodType: 'wet', q: 'wet cat food' },
  { pet: 'dog', foodType: 'treat', q: 'dog treats' },
  { pet: 'cat', foodType: 'treat', q: 'cat treats' },
];

// Preliminary brand-level quality scores (same approach used to seed the first
// 40 products) so newly-added Chewy items don't display as "0.0".
const BRAND_SCORES = {
  'orijen': 9.0, 'acana': 8.5, 'ziwi': 8.7, "stella & chewy's": 8.5, 'instinct': 8.3,
  'vital essentials': 8.2, 'wellness': 8.0, 'nulo': 8.0, 'taste of the wild': 7.8, 'merrick': 7.8,
  'blue buffalo': 7.5, 'full moon': 7.5, 'american journey': 7.2, 'purina pro plan': 7.2,
  "hill's science diet": 7.0, "hill's": 7.0, 'diamond': 7.0, 'nutro': 7.0, 'kirkland': 7.0,
  'greenies': 6.8, 'inaba': 7.0, 'purina one': 6.5, 'crave': 6.5, 'rachael ray nutrish': 6.5,
  'iams': 6.2, 'sheba': 6.0, 'pedigree': 5.5, 'fancy feast': 5.5, 'cesar': 5.5, 'temptations': 5.5,
  'cat chow': 5.5, 'purina': 5.5, 'beneful': 5.2, 'friskies': 5.0, 'meow mix': 5.0, 'whiskas': 5.0,
  'milk-bone': 5.0,
};
function brandScore(brand) {
  const b = String(brand || '').toLowerCase().trim();
  if (BRAND_SCORES[b] != null) return BRAND_SCORES[b];
  for (const k of Object.keys(BRAND_SCORES)) { if (b.includes(k) || k.includes(b)) return BRAND_SCORES[k]; }
  return 6.0; // neutral default
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// GET against the Impact API with HTTP Basic auth (AccountSID:AuthToken), JSON.
async function impactGet(cfg, pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.impact.com${pathOrUrl}`;
  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 500);
    if (cfg.log) cfg.log(`[err] Impact HTTP ${res.status}: ${snippet}`);
    throw new Error(`Impact HTTP ${res.status}: ${snippet}`);
  }
  try { return JSON.parse(text); }
  catch (_e) { if (cfg.log) cfg.log(`[err] Impact returned non-JSON: ${text.slice(0, 300)}`); throw new Error('Impact returned non-JSON response'); }
}

// List the partner's catalogs so the user can find the Chewy catalog id.
async function listCatalogs(cfg) {
  const data = await impactGet(cfg, `/Mediapartners/${cfg.sid}/Catalogs?PageSize=100`);
  const cats = data.Catalogs || data.Catalog || [];
  cfg.log(`[impact] ${cats.length} catalog(s) available on your account:`);
  for (const c of cats) {
    cfg.log(`  · id=${c.Id || c.CatalogId} name="${c.Name}" items=${c.NumberOfItems || c.ItemCount || '?'} advertiser="${c.AdvertiserName || c.CampaignName || ''}"`);
  }
  return cats.map((c) => ({ id: c.Id || c.CatalogId, name: c.Name, advertiser: c.AdvertiserName || c.CampaignName || '' }));
}

// Search a catalog for a query string (Impact "Search catalog" endpoint). The
// Chewy catalog has 200k+ items, so we search per product instead of scanning.
async function itemSearch(cfg, query) {
  // `Query` is a field-operator expression (fields: Name, Manufacturer,
  // CurrentPrice, …; operators: ~ = contains, =, >, <, AND, OR, IN). A keyword
  // search on the product name is: Name~"phrase". ItemSearch rejects a CatalogId
  // param; it searches all of the account's catalogs (fine — Chewy is the only one).
  const phrase = String(query).replace(/["]+/g, ' ').trim();
  const params = new URLSearchParams({ Query: `Name~"${phrase}"`, PageSize: '50' });
  const data = await impactGet(cfg, `/Mediapartners/${cfg.sid}/Catalogs/ItemSearch?${params.toString()}`);
  return data.Items || data.Products || data.CatalogItems || [];
}

// Query candidates for a product, tried in order until a strong match is found.
// Apostrophes are kept (so "Hill's" matches Chewy's "Hill's"); a "skip the first
// word" tier rescues apostrophe-first brands (Hill's → "Science Diet Adult").
function queriesFor(p) {
  const words = String(p.name || p.brand || '')
    .replace(/[^A-Za-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 1);
  const tiers = [
    words.slice(0, 4),
    words.slice(0, 3),
    words.slice(1, 4), // drop the first word
    words.slice(0, 2), // brand only
  ];
  return [...new Set(tiers.map((t) => t.join(' ')).filter((s) => s))];
}

// --- pack-size + bundle guards (so a 5-lb bag isn't matched to a 15-lb bundle) ---
// Chewy often lists combos ("Bundle: Dry Food + Canned…"); reject those unless
// our product is itself a bundle.
const isBundle = (name) => /\bbundle\b|\bcombo\b|\bgift set\b|\s\+\s/i.test(String(name || ''));
// Approximate total package size in ounces from the name (lbs → oz, or oz × count).
function sizeOz(name) {
  const t = String(name || '').toLowerCase();
  let m;
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:lb\b|lbs\b|pound)/))) return parseFloat(m[1]) * 16;
  const oz = (m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:oz\b|ounce)/)) ? parseFloat(m[1]) : null;
  if (oz == null) return null;
  // A multi-pack count only counts if it's tied to a real count word — never a
  // bare comma-number (which would grab the "5" out of "5.5-oz").
  let cnt = null;
  if ((m = t.match(/(?:case|pack|count)\s*of\s*(\d+)/))) cnt = parseInt(m[1], 10);
  else if ((m = t.match(/(\d+)\s*-?\s*(?:ct\b|count\b|packs?\b|cans?\b|pouch(?:es)?\b|tubs?\b|sticks?\b|pieces?\b|x\b)/))) cnt = parseInt(m[1], 10);
  return oz * (cnt || 1);
}
// Same-ish pack size (within ~20%). Unknown on either side → don't block.
function sizesCompatible(a, b) {
  const A = sizeOz(a), B = sizeOz(b);
  if (!A || !B) return true;
  const hi = Math.max(A, B), lo = Math.min(A, B);
  return lo / hi >= 0.8;
}

// --- protein/flavor guard (so turkey recipe ≠ chicken recipe) ---
const PROTEINS = ['chicken', 'turkey', 'beef', 'salmon', 'whitefish', 'tuna', 'lamb', 'duck',
  'venison', 'rabbit', 'pork', 'bison', 'trout', 'herring', 'mackerel', 'sardine', 'cod', 'liver'];
function primaryProtein(name) {
  const t = String(name || '').toLowerCase();
  let best = null, bestIdx = Infinity;
  for (const p of PROTEINS) { const i = t.indexOf(p); if (i >= 0 && i < bestIdx) { bestIdx = i; best = p; } }
  return best;
}
function proteinsCompatible(a, b) {
  if (/variety|sampler|multi.?flavor/i.test(String(a) + ' ' + String(b))) return true; // variety packs mix proteins
  const pa = primaryProtein(a), pb = primaryProtein(b);
  if (!pa || !pb) return true; // can't tell → don't block
  return pa === pb;
}

// --- life-stage guard (Adult ≠ Senior/7+ ≠ Puppy) ---
function lifeStage(name) {
  const t = String(name || '').toLowerCase();
  if (/\ball\s*life\s*stages?\b|all-life-stages/.test(t)) return 'all';
  if (/\bpuppy\b|\bkitten\b|\bgrowth\b/.test(t)) return 'puppy';
  if (/senior|mature|aging|\b7\s*\+|\b8\s*\+|\b11\s*\+/.test(t)) return 'senior';
  return 'adult';
}
function lifeStagesCompatible(a, b) {
  const la = lifeStage(a), lb = lifeStage(b);
  if (la === 'all' || lb === 'all') return true; // all-life-stages feeds any age
  return la === lb;
}

// --- breed-size guard (Large Breed ≠ Small/Toy Breed) ---
function breedSize(name) {
  const t = String(name || '').toLowerCase();
  if (/\b(small|toy|mini|little)\s*(?:breed|&\s*toy|bites)\b|\bsmall\s*&\s*mini\b/.test(t)) return 'small';
  if (/\b(large|giant|big)\s*breed\b/.test(t)) return 'large';
  return 'any';
}
function breedCompatible(a, b) {
  const ba = breedSize(a), bb = breedSize(b);
  if (ba === 'any' || bb === 'any') return true; // unspecified fits either
  return ba === bb;
}

// Fallback: Impact marketplace product search (needs the Products scope, not the
// catalog Search scope). Results span advertisers, so callers must Chewy-filter.
async function marketplaceSearch(cfg, query) {
  const params = new URLSearchParams({ Query: query, PageSize: '10' });
  const data = await impactGet(cfg, `/Mediapartners/${cfg.sid}/Marketplace/Products?${params.toString()}`);
  return data.Products || data.Items || data.MarketplaceProducts || [];
}

// Loose Chewy check for marketplace results (link or advertiser mentions chewy).
const looksChewy = (it) => JSON.stringify(it || '').toLowerCase().includes('chewy');

// Run fn over items with bounded concurrency (keeps the whole import in one request).
async function mapLimit(arr, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx], idx); }
  });
  await Promise.all(workers);
}

/**
 * For each product we stock, search the Chewy catalog, take the best fuzzy match
 * and upsert its price + tracked link. Returns a summary.
 */
async function importChewy(opts = {}) {
  const cfg = {
    sid: opts.sid || process.env.IMPACT_ACCOUNT_SID,
    token: opts.token || process.env.IMPACT_AUTH_TOKEN,
    catalogId: opts.catalogId || process.env.IMPACT_CHEWY_CATALOG_ID || null,
    supabaseUrl: opts.supabaseUrl || process.env.SUPABASE_URL,
    supabaseKey: opts.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
    maxItems: opts.maxItems != null ? opts.maxItems : (process.env.IMPACT_MAX_ITEMS ? parseInt(process.env.IMPACT_MAX_ITEMS, 10) : 3000),
    log: opts.log || ((m) => console.log(m)),
  };
  if (!cfg.sid || !cfg.token) throw new Error('Missing IMPACT_ACCOUNT_SID or IMPACT_AUTH_TOKEN');
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  // Discovery mode: no catalog id yet → list catalogs and stop.
  if (!cfg.catalogId) {
    cfg.log('[impact] No IMPACT_CHEWY_CATALOG_ID set — listing your catalogs so you can find it.');
    const catalogs = await listCatalogs(cfg);
    return { discovery: true, catalogs };
  }

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });
  const { data: products, error: pErr } = await supabase.from('products').select('upc,name,brand,image_url');
  if (pErr) throw pErr;

  // Decide which search endpoint we're allowed to use: prefer the direct catalog
  // search; if it's denied (403), fall back to the marketplace product search.
  let method = 'catalog';
  try { await itemSearch(cfg, 'dog food'); }
  catch (err) {
    if (/HTTP 403/.test(err.message)) {
      method = 'marketplace';
      cfg.log('[impact] Catalog "Search catalog" is denied (403) — falling back to Marketplace product search. To use the direct catalog instead, create a token with the "Search catalog" scope.');
    } else { throw err; }
  }
  const searchFn = method === 'marketplace' ? marketplaceSearch : itemSearch;
  cfg.log(`[chewy] ${method} search for ${products.length} products (catalog ${cfg.catalogId})`);

  let searched = 0, matched = 0, missed = 0;
  const errors = [];
  let loggedShape = false;

  await mapLimit(products, 5, async (p) => {
    const queries = queriesFor(p);
    if (!queries.length) { missed += 1; return; }
    // Try each query tier, keep the best fuzzy match; stop early on a strong hit.
    let best = null;
    for (const q of queries) {
      let items = [];
      try { items = await searchFn(cfg, q); searched += 1; }
      catch (err) { errors.push({ upc: p.upc, message: err.message }); cfg.log(`[ERR] search "${q}": ${err.message}`); continue; }
      if (!loggedShape && items[0]) { loggedShape = true; cfg.log(`[shape] first result: ${JSON.stringify(items[0]).slice(0, 1500)}`); }
      for (const it of items) {
        if (method === 'marketplace' && !looksChewy(it)) continue; // marketplace spans stores
        const nm = it.Name || it.ProductName || it.Title;
        if (!nm) continue;
        if (isBundle(nm) && !isBundle(p.name)) continue;     // skip Chewy combos/bundles
        if (!sizesCompatible(p.name, nm)) continue;          // require same-ish pack size
        if (!proteinsCompatible(p.name, nm)) continue;       // require same primary protein/flavor
        if (!lifeStagesCompatible(p.name, nm)) continue;     // Adult ≠ Senior/7+ ≠ Puppy
        if (!breedCompatible(p.name, nm)) continue;          // Large Breed ≠ Small Breed
        const r = bestMatch(nm, [p]);
        if (r && (!best || r.score > best.score)) best = { it: it, score: r.score };
      }
      if (best && best.score >= 0.6) break; // strong enough — no need to try broader tiers
    }
    if (!best) {
      missed += 1;
      // Drop any stale Chewy price from an earlier, looser run (e.g. a bad bundle match).
      try { await supabase.from('prices').delete().eq('upc', p.upc).eq('store', 'chewy'); } catch (_e) {}
      cfg.log(`[chewy] miss  "${String(p.name).slice(0, 50)}"`);
      return;
    }

    const it = best.it;
    const price = num(it.CurrentPrice ?? it.SalePrice ?? it.Price ?? it.OriginalPrice);
    const link = it.Url || it.TrackingUrl || it.DirectUrl || it.ProductUrl || null;
    const image = it.ImageUrl || it.ImageURL || it.Image || null;
    // If the feed exposes a Chewy Autoship/subscribe price under any of these
    // names, capture it (the app already prefers autoship → sub&save → price).
    const autoship = num(it.AutoshipPrice ?? it.AutoShipPrice ?? it.SubscriptionPrice ?? it.SubscribePrice ?? it.SubscribeAndSavePrice);
    try {
      const { error } = await supabase.from('prices').upsert({
        upc: p.upc, store: 'chewy', price,
        autoship_price: autoship, subscribe_save_price: null,
        in_stock: true, affiliate_url: link, updated_at: new Date().toISOString(),
      }, { onConflict: 'upc,store' });
      if (error) throw error;
      if (image && !p.image_url) {
        await supabase.from('products').update({ image_url: image, updated_at: new Date().toISOString() }).eq('upc', p.upc);
      }
      matched += 1;
      cfg.log(`[chewy] MATCH "${String(p.name).slice(0, 40)}" -> "${String(it.Name).slice(0, 34)}"  $${price ?? '—'}  (j=${best.score.toFixed(2)})`);
    } catch (err) {
      errors.push({ upc: p.upc, message: err.message });
      cfg.log(`[ERR] upsert ${p.upc}: ${err.message}`);
    }
  });

  cfg.log(`Done — ${searched} searched, ${matched} matched, ${missed} missed, ${errors.length} errors`);
  return { searched, matched, missed, errors: errors.length };
}

/**
 * Add Chewy-only products (ones our Amazon seed doesn't have): search Chewy by
 * category, skip anything we already stock, and insert the rest as new products
 * with a Chewy price + tracked link + a preliminary brand-level score.
 */
async function seedChewyExtras(opts = {}) {
  const cfg = {
    sid: opts.sid || process.env.IMPACT_ACCOUNT_SID,
    token: opts.token || process.env.IMPACT_AUTH_TOKEN,
    supabaseUrl: opts.supabaseUrl || process.env.SUPABASE_URL,
    supabaseKey: opts.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
    perCategory: opts.perCategory != null ? opts.perCategory : (process.env.CHEWY_EXTRAS_PER_CATEGORY ? parseInt(process.env.CHEWY_EXTRAS_PER_CATEGORY, 10) : 12),
    log: opts.log || ((m) => console.log(m)),
  };
  if (!cfg.sid || !cfg.token) throw new Error('Missing IMPACT_ACCOUNT_SID or IMPACT_AUTH_TOKEN');
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });
  const { data: existing, error: pErr } = await supabase.from('products').select('upc,name,brand');
  if (pErr) throw pErr;
  const products = existing || [];
  cfg.log(`[extras] adding Chewy-only products (up to ${cfg.perCategory}/category); ${products.length} existing to dedupe against`);

  let added = 0, skipped = 0;
  const errors = [];
  const perCat = {};

  for (const s of EXTRA_SEARCHES) {
    let items = [];
    try { items = await itemSearch(cfg, s.q); }
    catch (err) { errors.push({ q: s.q, message: err.message }); cfg.log(`[ERR] extras search "${s.q}": ${err.message}`); perCat[s.q] = 0; continue; }

    let catAdded = 0;
    for (const it of items) {
      if (catAdded >= cfg.perCategory) break;
      const name = it.Name || it.ProductName;
      if (!name) continue;
      if (isBundle(name)) { skipped += 1; continue; } // don't add combo/bundle listings
      // skip anything we already stock — the matching phase attaches Chewy prices to those
      const dup = bestMatch(name, products);
      if (dup && dup.score >= 0.6) { skipped += 1; continue; }

      const gtin = String(it.Gtin || '').replace(/\D/g, '');
      const upc = (gtin.length >= 8 && gtin.length <= 14) ? gtin : `chewy_${it.CatalogItemId || it.Id}`;
      if (products.some((x) => x.upc === upc)) { skipped += 1; continue; }

      const brand = it.Manufacturer || brandOf(name);
      const category = `${s.pet}_${s.foodType || foodTypeOf(name)}`;
      const image = it.ImageUrl || it.ImageURL || null;
      const price = num(it.CurrentPrice ?? it.SalePrice ?? it.Price ?? it.OriginalPrice);
      const link = it.Url || it.TrackingUrl || it.DirectUrl || null;
      try {
        let e;
        ({ error: e } = await supabase.from('products').upsert({ upc, name, brand, category, life_stage: lifeStageOf(name), image_url: image, updated_at: new Date().toISOString() }, { onConflict: 'upc' }));
        if (e) throw e;
        ({ error: e } = await supabase.from('prices').upsert({ upc, store: 'chewy', price, autoship_price: null, subscribe_save_price: null, in_stock: true, affiliate_url: link, updated_at: new Date().toISOString() }, { onConflict: 'upc,store' }));
        if (e) throw e;
        ({ error: e } = await supabase.from('quality_scores').upsert({ upc, overall_score: brandScore(brand), recall_count: 0, aafco_certified: true, scoring_notes: 'preliminary brand-level estimate (Chewy import) — pending full scoring', scored_at: new Date().toISOString() }, { onConflict: 'upc' }));
        if (e) throw e;

        products.push({ upc, name, brand }); // dedupe subsequent items against this one
        added += 1; catAdded += 1;
        cfg.log(`[extras+] ${category} "${String(name).slice(0, 48)}"  $${price ?? '—'}  (${brand})`);
      } catch (err) {
        errors.push({ name, message: err.message });
        cfg.log(`[ERR] add "${String(name).slice(0, 40)}": ${err.message}`);
      }
    }
    perCat[s.q] = catAdded;
  }

  cfg.log(`Done — ${added} Chewy-only products added, ${skipped} skipped (already stocked), ${errors.length} errors`);
  return { added, skipped, perCategory: perCat, errors: errors.length };
}

if (require.main === module) {
  const run = process.argv[2] === 'extras' ? seedChewyExtras() : importChewy();
  Promise.resolve(run)
    .then((r) => { if (r && r.errors > 0) process.exit(1); })
    .catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
}

module.exports = { importChewy, seedChewyExtras, listCatalogs };

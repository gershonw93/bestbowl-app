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
const { bestMatch } = require('./seed-real-products.js');

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
  // NB: `Query` is an expression, so a bare multi-word string fails to parse —
  // it must be a quoted phrase. Also, ItemSearch rejects a `CatalogId` param; it
  // searches all of the account's catalogs (fine — Chewy is the only one here).
  const phrase = '"' + String(query).replace(/["]+/g, ' ').trim() + '"';
  const params = new URLSearchParams({ Query: phrase, PageSize: '25' });
  const data = await impactGet(cfg, `/Mediapartners/${cfg.sid}/Catalogs/ItemSearch?${params.toString()}`);
  return data.Items || data.Products || data.CatalogItems || [];
}

// Build a short, punctuation-free query from a product name (brand + a few
// distinctive words) so the quoted phrase is likely to appear in Chewy titles.
function searchQueryFor(p) {
  const clean = String(p.name || p.brand || '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .join(' ');
  return clean || String(p.brand || 'pet food');
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
    const query = searchQueryFor(p);
    if (!query) { missed += 1; return; }
    let items;
    try { items = await searchFn(cfg, query); searched += 1; }
    catch (err) { errors.push({ upc: p.upc, message: err.message }); cfg.log(`[ERR] search "${query.slice(0, 36)}": ${err.message}`); return; }

    if (!loggedShape && items[0]) { loggedShape = true; cfg.log(`[shape] first result: ${JSON.stringify(items[0]).slice(0, 400)}`); }

    // pick the Chewy result that best matches THIS product (name Jaccard >= 0.5)
    let best = null;
    for (const it of items) {
      if (method === 'marketplace' && !looksChewy(it)) continue; // marketplace spans stores
      const nm = it.Name || it.ProductName || it.Title;
      if (!nm) continue;
      const r = bestMatch(nm, [p]);
      if (r && (!best || r.score > best.score)) best = { it: it, score: r.score };
    }
    if (!best) { missed += 1; cfg.log(`[chewy] miss  "${String(p.name).slice(0, 50)}"`); return; }

    const it = best.it;
    const price = num(it.CurrentPrice ?? it.SalePrice ?? it.Price ?? it.OriginalPrice);
    const link = it.Url || it.TrackingUrl || it.DirectUrl || it.ProductUrl || null;
    const image = it.ImageUrl || it.ImageURL || it.Image || null;
    try {
      const { error } = await supabase.from('prices').upsert({
        upc: p.upc, store: 'chewy', price,
        autoship_price: null, subscribe_save_price: null,
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

if (require.main === module) {
  importChewy()
    .then((r) => { if (r && r.errors > 0) process.exit(1); })
    .catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
}

module.exports = { importChewy, listCatalogs };

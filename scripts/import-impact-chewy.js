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

/**
 * Import Chewy catalog items and upsert matched prices. Returns a summary.
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
  cfg.log(`[chewy] ${products.length} existing products loaded for matching`);

  let fetched = 0, matched = 0, missed = 0, page = 1;
  const errors = [];
  let uri = `/Mediapartners/${cfg.sid}/Catalogs/${cfg.catalogId}/Items?PageSize=100&Page=1`;

  while (uri && fetched < cfg.maxItems) {
    const data = await impactGet(cfg, uri);
    const items = data.Items || data.CatalogItems || [];
    if (page === 1 && items[0]) cfg.log(`[shape] first item: ${JSON.stringify(items[0]).slice(0, 400)}`);
    cfg.log(`[chewy] page ${page}: ${items.length} items`);

    for (const it of items) {
      fetched += 1;
      const name = it.Name || it.ProductName || it.Title;
      if (!name) continue;
      const price = num(it.CurrentPrice ?? it.SalePrice ?? it.Price ?? it.OriginalPrice);
      const link = it.Url || it.TrackingUrl || it.DirectUrl || it.ProductUrl || null;
      const image = it.ImageUrl || it.ImageURL || it.Image || null;

      const m = bestMatch(name, products);
      if (!m) { missed += 1; continue; }
      try {
        const { error } = await supabase.from('prices').upsert({
          upc: m.product.upc, store: 'chewy', price,
          autoship_price: null, subscribe_save_price: null,
          in_stock: true, affiliate_url: link, updated_at: new Date().toISOString(),
        }, { onConflict: 'upc,store' });
        if (error) throw error;
        // opportunistically fill a missing product image from Chewy
        if (image && !m.product.image_url) {
          await supabase.from('products').update({ image_url: image, updated_at: new Date().toISOString() }).eq('upc', m.product.upc);
          m.product.image_url = image;
        }
        matched += 1;
        cfg.log(`[chewy] MATCH "${String(name).slice(0, 44)}" -> ${String(m.product.name).slice(0, 36)}  $${price ?? '—'}  (j=${m.score.toFixed(2)})`);
      } catch (err) {
        errors.push({ name, message: err.message });
        cfg.log(`[ERR] upsert ${m.product.upc}: ${err.message}`);
      }
    }

    const next = data['@nextpageuri'] || data.NextPageUri || data.nextpageuri || null;
    uri = next || null;
    page += 1;
    if (page > 200) break; // hard safety stop
  }

  cfg.log(`Done — ${fetched} catalog items scanned, ${matched} matched, ${missed} missed, ${errors.length} errors`);
  return { fetched, matched, missed, errors: errors.length };
}

if (require.main === module) {
  importChewy()
    .then((r) => { if (r && r.errors > 0) process.exit(1); })
    .catch((err) => { console.error('[FATAL]', err.message); process.exit(1); });
}

module.exports = { importChewy, listCatalogs };

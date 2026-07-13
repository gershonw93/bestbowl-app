/**
 * api/seed-products.js  — Vercel serverless function
 *
 * Browser-triggerable seed of real products into Supabase. Two phases:
 *   1. Amazon best-seller dog/cat food + treat categories (4 credits) → products + prices
 *   2. Chewy + Walmart category searches (8 credits) → matched into prices
 * Use ?phase=stores to run ONLY phase 2 (saves the 4 Amazon credits), or
 * ?phase=amazon for only phase 1. With no phase, both run (12 credits).
 *   e.g.  https://<app>.vercel.app/api/seed-products?secret=<SEED_SECRET>&phase=stores
 *
 * ?phase=chewy imports REAL Chewy prices + tracking links from the Impact.com
 * product catalog (needs IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN, and optionally
 * IMPACT_CHEWY_CATALOG_ID — leave it unset once to list your catalogs).
 *   e.g.  https://<app>.vercel.app/api/seed-products?secret=<SEED_SECRET>&phase=chewy
 *
 * Authenticated two ways — both checked against the SEED_SECRET env var:
 *   1. Header (e.g. from hoppscotch.io):
 *        POST https://<your-app>.vercel.app/api/seed-products
 *        Header:  x-seed-secret: <value of SEED_SECRET>
 *   2. Query param (browser-friendly — just visit the URL):
 *        GET  https://<your-app>.vercel.app/api/seed-products?secret=<value of SEED_SECRET>
 *
 * Each successful call spends 4 Rainforest credits and writes to the DB, so the
 * secret must match or the request is rejected with 401.
 *
 * Required Vercel environment variables:
 *   SEED_SECRET, RAINFOREST_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   (optional: AMAZON_PARTNER_TAG, SEED_LIMIT)
 */

const { seed, seedStores } = require('../scripts/seed-real-products.js');
const { importChewy } = require('../scripts/import-impact-chewy.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // --- auth: require the secret via the x-seed-secret header OR a ?secret=
  // query param. Both are compared against SEED_SECRET so the endpoint can be
  // triggered from a tool (header) or a plain browser tab (query string).
  const expected = process.env.SEED_SECRET;
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'SEED_SECRET is not configured on the server' });
  }
  // req.query is populated by Vercel; fall back to parsing the URL just in case.
  const querySecret =
    (req.query && req.query.secret) ||
    (() => {
      try { return new URL(req.url, 'http://localhost').searchParams.get('secret'); }
      catch (_e) { return null; }
    })();
  const provided = req.headers['x-seed-secret'] || querySecret;
  if (provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: missing or invalid seed secret' });
  }

  // ?phase= controls which seed phases run:
  //   (absent)  → Amazon bestsellers (4 credits) THEN Chewy/Walmart (8 credits)
  //   stores    → ONLY the Chewy/Walmart price phase (8 credits, no Amazon)
  //   amazon    → ONLY the Amazon bestsellers phase (4 credits)
  const phase =
    (req.query && req.query.phase) ||
    (() => { try { return new URL(req.url, 'http://localhost').searchParams.get('phase'); } catch (_e) { return null; } })();

  const log = [];
  const out = {};
  try {
    if (phase === 'chewy') {
      // Real Chewy prices + tracking links from the Impact.com product catalog.
      out.chewy = await importChewy({ log: (m) => log.push(m) });
    } else {
      if (phase !== 'stores') {
        out.amazon = await seed({
          perCategory: 20,   // top 20 per category
          delayMs: 800,      // short pause between the category calls
          partnerTag: process.env.AMAZON_PARTNER_TAG || 'bestbowl0a-20', // affiliate tag
          log: (m) => log.push(m),
        });
      }
      if (phase !== 'amazon') {
        out.stores = await seedStores({ log: (m) => log.push(m) });
      }
    }
    return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), phase: phase || 'all', ...out, log });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, log });
  }
};

// Up to 12 external calls (4 Amazon + 8 store searches); raise the limit.
module.exports.config = { maxDuration: 300 };

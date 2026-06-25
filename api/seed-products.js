/**
 * api/seed-products.js  — Vercel serverless function
 *
 * Browser-triggerable seed of real Amazon products into Supabase. Pulls the
 * Amazon best-seller dog/cat food + treat categories via Rainforest — one
 * credit per category (4 = 4 credits) — upserting into products + prices.
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

const { seed } = require('../scripts/seed-real-products.js');

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

  const log = [];
  try {
    const result = await seed({
      perCategory: 20,   // top 20 per category
      delayMs: 800,      // short pause between the 2 category calls
      partnerTag: process.env.AMAZON_PARTNER_TAG || 'bestbowl0a-20', // affiliate tag
      log: (m) => log.push(m),
    });
    return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), ...result, log });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, log });
  }
};

// Only 4 external calls, but raise the limit to be safe.
module.exports.config = { maxDuration: 60 };

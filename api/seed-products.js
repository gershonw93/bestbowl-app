/**
 * api/seed-products.js  — Vercel serverless function
 *
 * Browser-triggerable one-shot seed of real Amazon products into Supabase.
 * Runs the same logic as scripts/seed-real-products.js in SEARCH mode with
 * SEED_LIMIT=20 (first run), so it doesn't depend on hardcoded ASINs.
 *
 * Trigger (e.g. from hoppscotch.io):
 *   POST https://<your-app>.vercel.app/api/seed-products
 *   Header:  x-seed-secret: <value of SEED_SECRET>
 *
 * Required Vercel environment variables:
 *   SEED_SECRET, RAINFOREST_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   (optional: AMAZON_PARTNER_TAG)
 *
 * Note: ~20 calls with a short delay; maxDuration is raised to 60s. If it ever
 * times out, lower the limit by editing the `limit` below.
 */

const { seed } = require('../scripts/seed-real-products.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expected = process.env.SEED_SECRET;
  const provided = req.headers['x-seed-secret'];
  if (!expected) return res.status(500).json({ ok: false, error: 'SEED_SECRET is not configured on the server' });
  if (!provided || provided !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const log = [];
  try {
    const result = await seed({
      lookup: 'search',   // resolve by name — reliable for a first run
      limit: 20,          // first-run credit cap
      delayMs: 800,       // lighter delay to stay within the serverless timeout
      log: (m) => log.push(m),
    });
    return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), ...result, log });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, log });
  }
};

// Raise the serverless execution limit (~20 lookups * (0.8s + API latency)).
module.exports.config = { maxDuration: 60 };

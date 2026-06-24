/**
 * api/seed-products.js  — Vercel serverless function
 *
 * Browser-triggerable seed of real Amazon products into Supabase. Pulls the
 * Amazon best-seller dog-food and cat-food categories via Rainforest — only
 * TWO credits total — and upserts the top products into products + prices.
 *
 * Trigger (e.g. from hoppscotch.io):
 *   POST https://<your-app>.vercel.app/api/seed-products
 *   Header:  x-seed-secret: <value of SEED_SECRET>
 *
 * ⚠ AUTH IS TEMPORARILY DISABLED (see below) so this can be hit from a plain
 *   browser URL for the first seed run. RE-ENABLE the x-seed-secret check (or
 *   delete this function) immediately after — anyone with the URL can trigger
 *   it, and each call spends 2 Rainforest credits and writes to the DB.
 *
 * Required Vercel environment variables:
 *   SEED_SECRET, RAINFOREST_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   (optional: AMAZON_PARTNER_TAG, SEED_LIMIT)
 */

const { seed } = require('../scripts/seed-real-products.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ⚠ TEMPORARY: secret check disabled for the first run. Re-enable by
  // uncommenting the four lines below.
  // const expected = process.env.SEED_SECRET;
  // const provided = req.headers['x-seed-secret'];
  // if (!expected) return res.status(500).json({ ok: false, error: 'SEED_SECRET is not configured on the server' });
  // if (!provided || provided !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const log = [];
  try {
    const result = await seed({
      perCategory: 20,   // top 20 per category
      delayMs: 800,      // short pause between the 2 category calls
      log: (m) => log.push(m),
    });
    return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), ...result, log });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, log });
  }
};

// Only 2 external calls, but raise the limit to be safe.
module.exports.config = { maxDuration: 60 };

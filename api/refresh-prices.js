/**
 * api/refresh-prices.js  — Vercel serverless function
 *
 * Invoked nightly by the pg_cron job defined in
 * supabase/migrations/0002_scheduled_refresh.sql.
 *
 * 1. Verifies the shared secret in the `x-cron-secret` header against
 *    process.env.CRON_SECRET (rejects with 401 otherwise).
 * 2. Runs all four importers in sequence by executing scripts/import-all.js,
 *    which itself skips any store whose API keys are missing.
 * 3. Returns a JSON summary of what was updated (parsed from each importer's
 *    `__SUMMARY__` line).
 *
 * Deployment notes:
 *   - Set CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and any store
 *     API keys (WALMART_API_KEY, AMAZON_*, RAINFOREST_API_KEY) as Vercel
 *     environment variables.
 *   - The scripts/ folder and node_modules must be included in the deployment.
 */

const path = require('path');
const { spawnSync } = require('child_process');

module.exports = (req, res) => {
  // --- auth: constant-ish comparison of the shared secret ---
  const provided = req.headers['x-cron-secret'];
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return res
      .status(500)
      .json({ ok: false, error: 'CRON_SECRET is not configured on the server' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // --- run all importers in sequence ---
  const scriptPath = path.join(process.cwd(), 'scripts', 'import-all.js');
  const child = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: process.env,
    // Importers (esp. Amazon, with 1s/UPC) can take a while; allow up to 5 min.
    timeout: 5 * 60 * 1000,
  });

  const stdout = child.stdout || '';
  const stderr = child.stderr || '';

  // Parse every per-store __SUMMARY__ line.
  const stores = stdout
    .split('\n')
    .filter((l) => l.startsWith('__SUMMARY__ '))
    .map((l) => {
      try {
        return JSON.parse(l.replace('__SUMMARY__ ', ''));
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);

  const totalUpserted = stores.reduce(
    (sum, s) => sum + (s.inserted || 0) + (s.updated || 0),
    0
  );

  const ok = child.status === 0;
  return res.status(ok ? 200 : 500).json({
    ok,
    ran_at: new Date().toISOString(),
    total_price_rows_upserted: totalUpserted,
    stores,
    ...(ok ? {} : { exit_code: child.status, stderr: stderr.slice(-2000) }),
  });
};

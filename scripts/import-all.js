/**
 * import-all.js
 *
 * Master importer that runs every store importer in sequence:
 *   Chewy → Walmart → Amazon → PetSmart
 *
 * This is the script the nightly schedule invokes (see
 * supabase/migrations/0002_scheduled_refresh.sql and api/refresh-prices.js).
 *
 * Behaviour:
 *   - Skips any importer whose required API key(s) are missing from .env,
 *     logging a clear message (the individual importers also exit gracefully,
 *     but skipping here avoids spawning them at all).
 *   - Runs each importer as a child process and parses its `__SUMMARY__` line.
 *   - Prints a final table of which stores were updated and how many price
 *     rows were upserted (inserted + updated).
 *
 * Chewy requires no API key (it reads CHEWY_FEED_URL or the local mock file),
 * so it always runs.
 */

require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');

// Each importer + the env var(s) it needs. `requires: []` means "always run".
const IMPORTERS = [
  { store: 'chewy', script: 'import-chewy.js', requires: [] },
  { store: 'walmart', script: 'import-walmart.js', requires: ['WALMART_API_KEY'] },
  {
    store: 'amazon',
    script: 'import-amazon.js',
    requires: ['AMAZON_ACCESS_KEY', 'AMAZON_SECRET_KEY', 'AMAZON_PARTNER_TAG'],
  },
  {
    store: 'petsmart',
    script: 'import-petsmart.js',
    requires: ['RAINFOREST_API_KEY'],
  },
];

function missingKeys(requires) {
  return requires.filter((k) => !process.env[k]);
}

function runImporter(importer) {
  const scriptPath = path.join(__dirname, importer.script);
  console.log(`\n========== ${importer.store.toUpperCase()} ==========`);

  const child = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: process.env,
  });

  // Stream the child's output through (it was captured, not inherited).
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);

  // Parse the machine-readable summary line if present.
  let summary = null;
  if (child.stdout) {
    const line = child.stdout
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('__SUMMARY__ '));
    if (line) {
      try {
        summary = JSON.parse(line.replace('__SUMMARY__ ', ''));
      } catch (_e) {
        /* ignore malformed summary */
      }
    }
  }

  return {
    store: importer.store,
    status: child.status === 0 ? 'ok' : 'error',
    exitCode: child.status,
    summary,
  };
}

function main() {
  console.log('BestBowl — running all price importers (Chewy → Walmart → Amazon → PetSmart)');

  const outcomes = [];

  for (const importer of IMPORTERS) {
    const missing = missingKeys(importer.requires);
    if (missing.length) {
      console.log(
        `\n========== ${importer.store.toUpperCase()} ==========\n` +
          `[SKIP] ${importer.store}: missing ${missing.join(', ')} in .env`
      );
      outcomes.push({ store: importer.store, status: 'skipped', missing });
      continue;
    }
    outcomes.push(runImporter(importer));
  }

  // ---- final summary ----
  console.log('\n============ FINAL SUMMARY ============');
  let totalUpserted = 0;
  for (const o of outcomes) {
    if (o.status === 'skipped') {
      console.log(`  ${o.store.padEnd(9)} SKIPPED (missing ${o.missing.join(', ')})`);
    } else if (o.status === 'error') {
      console.log(`  ${o.store.padEnd(9)} ERROR (exit ${o.exitCode})`);
    } else if (o.summary) {
      const upserted = (o.summary.inserted || 0) + (o.summary.updated || 0);
      totalUpserted += upserted;
      console.log(
        `  ${o.store.padEnd(9)} OK — ${upserted} price row(s) upserted ` +
          `(${o.summary.inserted} new, ${o.summary.updated} updated, ` +
          `${o.summary.skipped} skipped, ${o.summary.errors} errors)`
      );
    } else {
      console.log(`  ${o.store.padEnd(9)} OK (no summary reported)`);
    }
  }
  console.log(`  ----------------------------------------`);
  console.log(`  TOTAL price rows upserted: ${totalUpserted}`);

  // Non-zero exit if any importer that actually ran failed.
  const anyError = outcomes.some((o) => o.status === 'error');
  process.exit(anyError ? 1 : 0);
}

main();

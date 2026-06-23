/**
 * import-opff.js
 *
 * Streams the Open Pet Food Facts CSV export, finds the products whose UPC
 * already exists in our `products` table, and stores real ingredient data in
 * the `ingredients` table.
 *
 * The export is a very large (multi-GB) gzipped, TAB-separated CSV. We never
 * load it into memory — we stream it through gunzip → csv-parse and process one
 * record at a time, stopping early once every one of our UPCs is matched.
 *
 *   fetch(gz) → zlib.createGunzip() → csv-parse(delimiter:'\t') → for-await
 *
 * Env (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - required (writes bypass RLS)
 *   OPFF_FEED_URL                             - optional override of the export URL
 *   OPFF_MAX_ROWS                             - optional safety cap (see below)
 *
 * Note on size limits: if the environment cannot process the whole file, set
 * OPFF_MAX_ROWS (e.g. 100000) to scan only the first N rows and log that a
 * partial scan happened. By default there is no cap, but we always stop early
 * as soon as all of our products are matched.
 *
 * Note on columns: the OFF CSV flattens nutriments into columns
 * (`proteins_100g`, `fat_100g`, `fiber_100g`) rather than a nested
 * `nutriments` object (which only exists in the JSON/MongoDB export).
 */

require('dotenv').config();

const zlib = require('zlib');
const fetch = require('node-fetch');
const { parse } = require('csv-parse');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FEED_URL =
  process.env.OPFF_FEED_URL ||
  'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
const MAX_ROWS = process.env.OPFF_MAX_ROWS
  ? parseInt(process.env.OPFF_MAX_ROWS, 10)
  : Infinity;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const PET_FOOD_TAGS = ['en:pet-foods', 'en:dog-foods', 'en:cat-foods'];

const includesAny = (haystack, needles) =>
  needles.some((n) => haystack.includes(n));

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parse the first ingredient (text before the first comma), cleaned up. */
function parseFirstIngredient(text) {
  if (!text) return null;
  const first = text.split(',')[0] || '';
  // Strip leading percentages / parentheticals / asterisks and trim.
  return first.replace(/\([^)]*\)/g, '').replace(/[*\d%.]+/g, '').trim() || null;
}

function deriveFlags(ingredientsText) {
  const t = (ingredientsText || '').toLowerCase();
  return {
    has_corn: /\bcorn\b|maize/.test(t),
    has_wheat: /\bwheat\b/.test(t),
    has_soy: /\bsoy\b|soya|soybean/.test(t),
    has_artificial_preservatives: /\b(bha|bht|ethoxyquin)\b/.test(t),
    has_byproducts: /by[-\s]?product/.test(t),
  };
}

function petTypeFromTags(tags) {
  if (tags.includes('en:dog-foods')) return 'dog';
  if (tags.includes('en:cat-foods')) return 'cat';
  return null;
}

async function loadOurUpcs() {
  const { data, error } = await supabase.from('products').select('upc');
  if (error) throw error;
  return new Set(data.map((r) => r.upc));
}

async function run() {
  const ourUpcs = await loadOurUpcs();
  console.log(`[opff] ${ourUpcs.size} product UPC(s) to match against.`);
  if (MAX_ROWS !== Infinity) {
    console.log(`[opff] OPFF_MAX_ROWS set — scanning at most ${MAX_ROWS} rows.`);
  }
  console.log(`[opff] streaming ${FEED_URL} ...\n`);

  const res = await fetch(FEED_URL);
  if (!res.ok) {
    throw new Error(`OPFF download failed: ${res.status} ${res.statusText}`);
  }

  const parser = parse({
    delimiter: '\t',
    columns: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_records_with_error: true,
  });

  const gunzip = zlib.createGunzip();
  res.body.on('error', (e) => parser.destroy(e));
  gunzip.on('error', (e) => parser.destroy(e));
  res.body.pipe(gunzip).pipe(parser);

  const matches = new Map(); // upc -> ingredient row
  let scanned = 0;
  let partial = false;

  for await (const row of parser) {
    scanned += 1;
    if (scanned > MAX_ROWS) {
      partial = true;
      break;
    }

    const tags = row.categories_tags || '';
    if (!includesAny(tags, PET_FOOD_TAGS)) continue;

    const upc = (row.code || '').trim();
    if (!upc || !ourUpcs.has(upc) || matches.has(upc)) continue;

    const ingredientsText = row.ingredients_text || null;
    const flags = deriveFlags(ingredientsText);

    matches.set(upc, {
      row: {
        upc,
        ingredients_text: ingredientsText,
        protein_percent: num(row['proteins_100g']),
        fat_percent: num(row['fat_100g']),
        fiber_percent: num(row['fiber_100g']),
        first_ingredient: parseFirstIngredient(ingredientsText),
        ...flags,
        raw_data: {
          code: upc,
          product_name: row.product_name || null,
          brands: row.brands || null,
          categories_tags: tags,
          pet_type: petTypeFromTags(tags),
        },
        imported_at: new Date().toISOString(),
      },
      pet_type: petTypeFromTags(tags),
    });

    console.log(`[opff] matched ${upc}  ${row.product_name || ''}`);

    if (matches.size === ourUpcs.size) {
      console.log('[opff] all products matched — stopping the stream early.');
      parser.destroy();
      break;
    }
  }

  // ---- write results ----
  let upserted = 0;
  if (matches.size) {
    const rows = [...matches.values()].map((m) => m.row);
    const { error } = await supabase
      .from('ingredients')
      .upsert(rows, { onConflict: 'upc' });
    if (error) throw error;
    upserted = rows.length;

    // Touch products.updated_at for matched UPCs (real data is now available).
    const now = new Date().toISOString();
    for (const upc of matches.keys()) {
      await supabase.from('products').update({ updated_at: now }).eq('upc', upc);
    }
  }

  console.log('\n--- Open Pet Food Facts import summary ---');
  console.log(`Rows scanned:        ${scanned}${partial ? ' (partial — hit OPFF_MAX_ROWS)' : ''}`);
  console.log(`Matched to products: ${matches.size} / ${ourUpcs.size}`);
  console.log(`Upserted ingredients: ${upserted}`);
  if (matches.size < ourUpcs.size) {
    console.log(
      '[note] Unmatched UPCs stay on mock fallback in score-quality.js. ' +
        'OPFF matches require our product UPCs to be real OFF barcodes.'
    );
  }
}

run().catch((err) => {
  console.error('[FATAL] opff import:', err.message);
  process.exit(1);
});

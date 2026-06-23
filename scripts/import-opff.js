/**
 * import-opff.js
 *
 * Streams the Open Pet Food Facts CSV export and attaches real ingredient data
 * to our products by FUZZY-MATCHING ON BRAND NAME (not UPC — our seed catalog
 * uses synthetic UPCs that don't exist in OFF, so brand matching is what works).
 *
 * The export is a very large (multi-GB) gzipped, TAB-separated CSV. We never
 * load it into memory — we stream it through gunzip → csv-parse and process one
 * record at a time, stopping early once every product has a candidate match.
 *
 *   fetch(gz) → zlib.createGunzip() → csv-parse(delimiter:'\t') → for-await
 *
 * Matching, per OFF row (only rows tagged as pet/dog/cat food):
 *   1. fuzzy-match the row's `brands` against our distinct product brands
 *      (case/spacing-insensitive substring or >=0.5 token Jaccard);
 *   2. for each of our products with that brand, keep the OFF row with the best
 *      product_name token overlap (and a pet_type match bonus) as its source of
 *      ingredient data.
 * Products whose brand never appears in OFF stay unmatched and fall back to mock
 * scoring in score-quality.js.
 *
 * Env (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - required (writes bypass RLS)
 *   OPFF_FEED_URL                             - optional override of the export URL
 *   OPFF_MAX_ROWS                             - optional safety cap (scan first N rows)
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

// Words to ignore when scoring product-name overlap.
const STOP = new Set([
  'grain', 'free', 'adult', 'puppy', 'kitten', 'senior', 'dry', 'wet', 'food',
  'formula', 'recipe', 'with', 'and', 'the', 'for', 'dog', 'dogs', 'cat', 'cats',
  'natural', 'health', 'complete', 'nutrition', 'lb', 'lbs', 'oz', 'pet',
]);

const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => normalize(s).split(' ').filter((t) => t && !STOP.has(t));

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  return inter / (new Set([...a, ...b]).size);
}

// Fuzzy brand match: substring either way, or >=0.5 token Jaccard, tested
// against the whole `brands` field and each comma-separated brand within it.
function brandMatches(rowBrands, ourBrand) {
  const rb = normalize(rowBrands);
  const bn = normalize(ourBrand);
  if (!rb || !bn) return false;
  if (rb.includes(bn) || bn.includes(rb)) return true;
  for (const part of String(rowBrands).split(',')) {
    const p = normalize(part);
    if (!p) continue;
    if (p.includes(bn) || bn.includes(p)) return true;
    if (jaccard(tokens(p), tokens(bn)) >= 0.5) return true;
  }
  return jaccard(tokens(rb), tokens(bn)) >= 0.5;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseFirstIngredient(text) {
  if (!text) return null;
  const first = text.split(',')[0] || '';
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

function petTypeFromCategory(category) {
  if (!category) return null;
  if (category.startsWith('dog')) return 'dog';
  if (category.startsWith('cat')) return 'cat';
  return null;
}

async function loadOurProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('upc, name, brand, category');
  if (error) throw error;
  return data;
}

function buildIngredientRow(upc, row, matchedBrand) {
  const ingredientsText = row.ingredients_text || null;
  const tags = row.categories_tags || '';
  return {
    upc,
    ingredients_text: ingredientsText,
    protein_percent: num(row['proteins_100g']),
    fat_percent: num(row['fat_100g']),
    fiber_percent: num(row['fiber_100g']),
    first_ingredient: parseFirstIngredient(ingredientsText),
    ...deriveFlags(ingredientsText),
    raw_data: {
      matched_by: 'brand',
      matched_brand: matchedBrand,
      off_code: row.code || null,
      product_name: row.product_name || null,
      brands: row.brands || null,
      categories_tags: tags,
      pet_type: petTypeFromTags(tags),
    },
    imported_at: new Date().toISOString(),
  };
}

async function run() {
  const products = await loadOurProducts();
  console.log(`[opff] ${products.length} product(s); matching on BRAND (fuzzy).`);
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

  // best candidate OFF row per product upc: { score, row, matchedBrand }
  const best = new Map();
  let scanned = 0;
  let partial = false;

  for await (const row of parser) {
    scanned += 1;
    if (scanned > MAX_ROWS) {
      partial = true;
      break;
    }

    const tags = row.categories_tags || '';
    if (!PET_FOOD_TAGS.some((t) => tags.includes(t))) continue;

    const rowBrands = row.brands || '';
    if (!rowBrands) continue;

    const rowPet = petTypeFromTags(tags);
    const rowNameTokens = tokens(row.product_name);

    for (const product of products) {
      if (!brandMatches(rowBrands, product.brand)) continue;

      // Avoid cross-species matches when both pet types are known.
      const ourPet = petTypeFromCategory(product.category);
      if (rowPet && ourPet && rowPet !== ourPet) continue;

      // Need ingredients to be useful.
      if (!row.ingredients_text) continue;

      const overlap = rowNameTokens.filter((t) =>
        tokens(product.name).includes(t)
      ).length;
      const score = overlap + (rowPet && ourPet && rowPet === ourPet ? 1 : 0) + 1; // +1 base for brand hit

      const existing = best.get(product.upc);
      if (!existing || score > existing.score) {
        best.set(product.upc, { score, row, matchedBrand: product.brand });
      }
    }

    // Early stop once every product has at least one candidate.
    if (best.size === products.length) {
      console.log('[opff] every product has a brand match — stopping early.');
      parser.destroy();
      break;
    }
  }

  // ---- write results ----
  let upserted = 0;
  const matchedBrands = new Set();
  if (best.size) {
    const rows = [...best.entries()].map(([upc, m]) => {
      matchedBrands.add(m.matchedBrand);
      console.log(
        `[opff] ${upc}  ${m.matchedBrand}  ←  "${m.row.product_name || ''}"`
      );
      return buildIngredientRow(upc, m.row, m.matchedBrand);
    });

    const { error } = await supabase
      .from('ingredients')
      .upsert(rows, { onConflict: 'upc' });
    if (error) throw error;
    upserted = rows.length;

    const now = new Date().toISOString();
    for (const upc of best.keys()) {
      await supabase.from('products').update({ updated_at: now }).eq('upc', upc);
    }
  }

  console.log('\n--- Open Pet Food Facts import summary ---');
  console.log(`Rows scanned:         ${scanned}${partial ? ' (partial — hit OPFF_MAX_ROWS)' : ''}`);
  console.log(`Products matched:     ${best.size} / ${products.length} (by brand)`);
  console.log(`Brands matched:       ${[...matchedBrands].sort().join(', ') || '(none)'}`);
  console.log(`Upserted ingredients: ${upserted}`);
  if (best.size < products.length) {
    console.log(
      '[note] Unmatched products fall back to mock scoring in score-quality.js.'
    );
  }
}

run().catch((err) => {
  console.error('[FATAL] opff import:', err.message);
  process.exit(1);
});

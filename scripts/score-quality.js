/**
 * score-quality.js
 *
 * Computes a BestBowl quality score for every product that does not yet have a
 * quality_scores row, or whose row is more than 7 days old, and upserts the
 * result back into `quality_scores`.
 *
 * Ingredient data is mocked per brand for now (see BRAND_DATA below); a later
 * version will derive it from real ingredient panels / FDA recall data.
 *
 * Scoring (max 10):
 *   Ingredient score (0-5)
 *     - first ingredient named meat = 2, meat meal = 1, else 0
 *     - protein > 30% = 1.5, 25-30% = 1, < 25% = 0
 *     - no corn/wheat/soy in first 5 = 1, one = 0.5, two+ = 0
 *     - no artificial preservatives (BHA/BHT/ethoxyquin) = 0.5
 *   Safety score (0-3)
 *     - 0 recalls (last 5 yrs) = 3, 1 recall = 1.5, 2+ = 0
 *   AAFCO score (0-2)
 *     - AAFCO statement present = 2, else 0
 *
 * Environment variables: see import-chewy.js / .env.example. Writing requires
 * the service role key (RLS bypass).
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '⚠  SUPABASE_SERVICE_ROLE_KEY not set — using the anon key. Writes will be ' +
      'blocked by RLS. Set the service role key to write scores.\n'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const NAMED_MEATS = [
  'chicken',
  'beef',
  'salmon',
  'turkey',
  'lamb',
  'duck',
  'venison',
  'buffalo',
  'bison',
];

// Mock ingredient data keyed by brand. has_fillers = corn/wheat/soy in top 5.
const BRAND_DATA = {
  'Blue Buffalo': {
    first_ingredient: 'Deboned Chicken',
    protein_percent: 26,
    has_fillers: false,
    recall_count: 1,
    aafco_certified: true,
  },
  'Purina Pro Plan': {
    first_ingredient: 'Chicken',
    protein_percent: 30,
    has_fillers: false,
    recall_count: 0,
    aafco_certified: true,
  },
  'Royal Canin': {
    first_ingredient: 'Chicken By-Product Meal',
    protein_percent: 28,
    has_fillers: true,
    recall_count: 0,
    aafco_certified: true,
  },
  "Hill's Science Diet": {
    first_ingredient: 'Chicken',
    protein_percent: 25,
    has_fillers: true,
    recall_count: 1,
    aafco_certified: true,
  },
  Wellness: {
    first_ingredient: 'Deboned Chicken',
    protein_percent: 28,
    has_fillers: false,
    recall_count: 0,
    aafco_certified: true,
  },
  'Taste of the Wild': {
    first_ingredient: 'Buffalo',
    protein_percent: 32,
    has_fillers: false,
    recall_count: 1,
    aafco_certified: true,
  },
  Merrick: {
    first_ingredient: 'Deboned Beef',
    protein_percent: 34,
    has_fillers: false,
    recall_count: 0,
    aafco_certified: true,
  },
  Orijen: {
    first_ingredient: 'Deboned Chicken',
    protein_percent: 38,
    has_fillers: false,
    recall_count: 0,
    aafco_certified: true,
  },
  Acana: {
    first_ingredient: 'Deboned Chicken',
    protein_percent: 35,
    has_fillers: false,
    recall_count: 0,
    aafco_certified: true,
  },
  Iams: {
    first_ingredient: 'Chicken',
    protein_percent: 27,
    has_fillers: true,
    recall_count: 0,
    aafco_certified: true,
  },
};

/** Returns 2 for a named meat, 1 for a meat meal, 0 otherwise. */
function firstIngredientPoints(firstIngredient) {
  if (!firstIngredient) return 0;
  const lower = firstIngredient.toLowerCase();
  const isMeat = NAMED_MEATS.some((m) => lower.includes(m));
  if (!isMeat) return 0;
  // "chicken meal", "chicken by-product meal", etc. score as a meat meal.
  if (lower.includes('meal') || lower.includes('by-product')) return 1;
  return 2;
}

function proteinPoints(proteinPercent) {
  if (proteinPercent == null) return 0;
  if (proteinPercent > 30) return 1.5;
  if (proteinPercent >= 25) return 1;
  return 0;
}

// has_fillers is a boolean in the mock data; treat true as "one filler present"
// (0.5) and false as "none" (1). The full corn/wheat/soy count will replace
// this once real ingredient panels are wired in.
function fillerPoints(hasFillers) {
  return hasFillers ? 0.5 : 1;
}

function preservativePoints(hasArtificialPreservatives) {
  return hasArtificialPreservatives ? 0 : 0.5;
}

function safetyPoints(recallCount) {
  if (recallCount >= 2) return 0;
  if (recallCount === 1) return 1.5;
  return 3;
}

function aafcoPoints(aafcoCertified) {
  return aafcoCertified ? 2 : 0;
}

function scoreProduct(data) {
  const ingredient =
    firstIngredientPoints(data.first_ingredient) +
    proteinPoints(data.protein_percent) +
    fillerPoints(data.has_fillers) +
    preservativePoints(data.has_artificial_preservatives === true);

  const safety = safetyPoints(data.recall_count);
  const aafco = aafcoPoints(data.aafco_certified);

  const overall = Math.round((ingredient + safety + aafco) * 10) / 10;

  return {
    ingredient_score: Math.round(ingredient * 10) / 10,
    safety_score: safety,
    aafco_score: aafco,
    overall_score: overall,
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function loadProductsNeedingScore() {
  const { data: products, error: prodErr } = await supabase
    .from('products')
    .select('upc, name, brand');
  if (prodErr) throw prodErr;

  const { data: scores, error: scoreErr } = await supabase
    .from('quality_scores')
    .select('upc, scored_at');
  if (scoreErr) throw scoreErr;

  const scoredAtByUpc = new Map(scores.map((s) => [s.upc, s.scored_at]));
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  return products.filter((p) => {
    const scoredAt = scoredAtByUpc.get(p.upc);
    if (!scoredAt) return true; // never scored
    return new Date(scoredAt).getTime() < cutoff; // older than 7 days
  });
}

async function run() {
  const products = await loadProductsNeedingScore();
  console.log(`${products.length} product(s) need scoring.\n`);

  let scored = 0;
  const skipped = [];
  const errors = [];

  for (const product of products) {
    const data = BRAND_DATA[product.brand];
    if (!data) {
      skipped.push({ upc: product.upc, brand: product.brand });
      console.warn(
        `  skipped  ${product.upc}  no ingredient data for brand "${product.brand}"`
      );
      continue;
    }

    try {
      const s = scoreProduct(data);
      const row = {
        upc: product.upc,
        overall_score: s.overall_score,
        ingredient_score: s.ingredient_score,
        safety_score: s.safety_score,
        aafco_score: s.aafco_score,
        first_ingredient: data.first_ingredient,
        protein_percent: data.protein_percent,
        recall_count: data.recall_count,
        aafco_certified: data.aafco_certified,
        has_fillers: data.has_fillers,
        scoring_notes: `ingredient ${s.ingredient_score}/5, safety ${s.safety_score}/3, aafco ${s.aafco_score}/2`,
        scored_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('quality_scores')
        .upsert(row, { onConflict: 'upc' });
      if (error) throw error;

      scored += 1;
      console.log(
        `  scored   ${product.upc}  ${product.brand}  →  ${s.overall_score}/10`
      );
    } catch (err) {
      errors.push({ upc: product.upc, message: err.message });
      console.error(`  ERROR    ${product.upc}  ${err.message}`);
    }
  }

  console.log('\n--- Scoring summary ---');
  console.log(`Scored:  ${scored}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Errors:  ${errors.length}`);
  if (errors.length) {
    console.log(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

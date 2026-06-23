/**
 * score-quality.js  (week 3 — real data)
 *
 * Recalculates quality_scores using REAL ingredient data from the `ingredients`
 * table (imported from Open Pet Food Facts) and REAL recall counts from the
 * `recalls` table (imported from openFDA), falling back to the original
 * hardcoded mock data per brand when a product has no real ingredient row yet.
 *
 * Scoring (unchanged ranges, week-3 formula):
 *   Ingredient (0-5):
 *     first_ingredient named meat = 2, meat meal = 1, else 0
 *     protein > 30% = 1.5, 25-30% = 1, < 25% = 0
 *     - 0.5 per filler present (corn / wheat / soy)
 *     - 1.0 if artificial preservatives (BHA/BHT/ethoxyquin)
 *     - 0.5 if by-products
 *     (clamped to [0, 5])
 *   Safety (0-3): 0 recalls = 3, 1 = 1.5, 2+ = 0   (last 5 years)
 *   AAFCO (0-2): aafco_certified (kept from existing quality_scores) = 2 else 0
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (writes bypass RLS).
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

const NAMED_MEATS = [
  'chicken', 'beef', 'salmon', 'turkey', 'lamb', 'duck', 'venison',
  'buffalo', 'bison', 'fish', 'whitefish', 'pork', 'rabbit',
];

// Fallback mock ingredient data per brand (used when no `ingredients` row).
const MOCK = {
  'Blue Buffalo':       { first_ingredient: 'Deboned Chicken', protein_percent: 26, has_fillers: false },
  'Purina Pro Plan':    { first_ingredient: 'Chicken', protein_percent: 30, has_fillers: false },
  'Royal Canin':        { first_ingredient: 'Chicken By-Product Meal', protein_percent: 28, has_fillers: true },
  "Hill's Science Diet":{ first_ingredient: 'Chicken', protein_percent: 25, has_fillers: true },
  'Wellness':           { first_ingredient: 'Deboned Chicken', protein_percent: 28, has_fillers: false },
  'Taste of the Wild':  { first_ingredient: 'Buffalo', protein_percent: 32, has_fillers: false },
  'Merrick':            { first_ingredient: 'Deboned Beef', protein_percent: 34, has_fillers: false },
  'Orijen':             { first_ingredient: 'Deboned Chicken', protein_percent: 38, has_fillers: false },
  'Acana':              { first_ingredient: 'Deboned Chicken', protein_percent: 35, has_fillers: false },
  'Iams':               { first_ingredient: 'Chicken', protein_percent: 27, has_fillers: true },
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;

function firstIngredientPoints(firstIngredient) {
  if (!firstIngredient) return 0;
  const lower = firstIngredient.toLowerCase();
  if (!NAMED_MEATS.some((m) => lower.includes(m))) return 0;
  if (lower.includes('meal') || lower.includes('by-product')) return 1;
  return 2;
}

function proteinPoints(p) {
  if (p == null) return 0;
  if (p > 30) return 1.5;
  if (p >= 25) return 1;
  return 0;
}

function ingredientScore(d) {
  let s = firstIngredientPoints(d.first_ingredient) + proteinPoints(d.protein_percent);
  const fillers = (d.has_corn ? 1 : 0) + (d.has_wheat ? 1 : 0) + (d.has_soy ? 1 : 0);
  s -= 0.5 * fillers;
  if (d.has_artificial_preservatives) s -= 1;
  if (d.has_byproducts) s -= 0.5;
  return clamp(s, 0, 5);
}

function safetyScore(recallCount) {
  if (recallCount >= 2) return 0;
  if (recallCount === 1) return 1.5;
  return 3;
}

const aafcoScore = (certified) => (certified ? 2 : 0);

const FIVE_YEARS_AGO = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d;
})();

async function run() {
  const [{ data: products, error: pErr },
         { data: ingredients, error: iErr },
         { data: scores, error: sErr },
         { data: recalls, error: rErr }] = await Promise.all([
    supabase.from('products').select('upc, brand'),
    supabase.from('ingredients').select('*'),
    supabase.from('quality_scores').select('upc, aafco_certified, recall_count, first_ingredient, protein_percent'),
    supabase.from('recalls').select('brand, recall_date'),
  ]);
  if (pErr) throw pErr;
  if (iErr) throw iErr;
  if (sErr) throw sErr;
  if (rErr) throw rErr;

  const ingByUpc = new Map(ingredients.map((r) => [r.upc, r]));
  const qsByUpc = new Map(scores.map((r) => [r.upc, r]));

  // Real recall counts (last 5 years) per brand, only if recalls were imported.
  const recallsImported = recalls.length > 0;
  const recallCountByBrand = new Map();
  for (const rec of recalls) {
    const recent = !rec.recall_date || new Date(rec.recall_date) >= FIVE_YEARS_AGO;
    if (!recent) continue;
    recallCountByBrand.set(rec.brand, (recallCountByBrand.get(rec.brand) || 0) + 1);
  }

  let real = 0;
  let mock = 0;
  const errors = [];

  for (const product of products) {
    try {
      const ing = ingByUpc.get(product.upc);
      const qs = qsByUpc.get(product.upc) || {};
      let data;
      let source;

      if (ing) {
        source = 'real';
        data = {
          first_ingredient: ing.first_ingredient,
          protein_percent: ing.protein_percent,
          has_corn: ing.has_corn,
          has_wheat: ing.has_wheat,
          has_soy: ing.has_soy,
          has_artificial_preservatives: ing.has_artificial_preservatives,
          has_byproducts: ing.has_byproducts,
        };
      } else {
        source = 'mock';
        const m = MOCK[product.brand];
        if (!m) {
          console.warn(`[skip] ${product.upc} no real or mock data for brand "${product.brand}"`);
          continue;
        }
        data = {
          first_ingredient: m.first_ingredient,
          protein_percent: m.protein_percent,
          // mock only knows "has_fillers" — treat as a single filler
          has_corn: m.has_fillers,
          has_wheat: false,
          has_soy: false,
          has_artificial_preservatives: false,
          has_byproducts: /by-product/i.test(m.first_ingredient || ''),
        };
      }

      // recall count: real from recalls table if imported, else existing value
      const recallCount = recallsImported
        ? recallCountByBrand.get(product.brand) || 0
        : qs.recall_count || 0;

      const aafcoCertified = qs.aafco_certified === true;

      const ingredient = ingredientScore(data);
      const safety = safetyScore(recallCount);
      const aafco = aafcoScore(aafcoCertified);
      const overall = round1(ingredient + safety + aafco);

      const row = {
        upc: product.upc,
        overall_score: overall,
        ingredient_score: round1(ingredient),
        safety_score: safety,
        aafco_score: aafco,
        first_ingredient: data.first_ingredient,
        protein_percent: data.protein_percent,
        recall_count: recallCount,
        aafco_certified: aafcoCertified,
        has_fillers: Boolean(data.has_corn || data.has_wheat || data.has_soy),
        scoring_notes: `source=${source}; ingredient ${round1(ingredient)}/5, safety ${safety}/3, aafco ${aafco}/2`,
        scored_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('quality_scores')
        .upsert(row, { onConflict: 'upc' });
      if (error) throw error;

      if (source === 'real') real += 1;
      else mock += 1;
      console.log(`[${source}] ${product.upc} ${product.brand} → ${overall}/10 (recalls: ${recallCount})`);
    } catch (err) {
      errors.push({ upc: product.upc, message: err.message });
      console.error(`[ERROR] ${product.upc}: ${err.message}`);
    }
  }

  console.log('\n--- Scoring summary ---');
  console.log(`Scored with REAL ingredient data: ${real}`);
  console.log(`Scored with MOCK fallback data:   ${mock}`);
  console.log(`Recall data source: ${recallsImported ? 'real (recalls table)' : 'existing/mock (no FDA import yet)'}`);
  console.log(`Errors: ${errors.length}`);
  if (errors.length) {
    console.log(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('[FATAL] score-quality:', err.message);
  process.exit(1);
});

/**
 * seed-multistore.js
 *
 * Inserts realistic *mock* prices for every existing product across Walmart,
 * Amazon, and PetSmart, derived from each product's existing Chewy price, so we
 * can test multi-store search results immediately without real API keys.
 *
 * Price rules (relative to the Chewy *regular* price):
 *   Walmart  : price = chewy * 1.08            (no autoship)
 *   Amazon   : price = chewy * 1.12,
 *              subscribe_save_price = amazon_price * 0.85
 *   PetSmart : price = chewy * 1.15            (no autoship)
 *
 * Affiliate URLs use real-looking slugs built from the product name.
 *
 * Environment: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (writes bypass RLS).
 * AMAZON_PARTNER_TAG is used in the Amazon URL if set (defaults to a placeholder).
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AMAZON_PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'bestbowl-20';

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

const round2 = (n) => Math.round(n * 100) / 100;

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildRows(product, chewyPrice) {
  const s = slug(product.name);
  const walmart = round2(chewyPrice * 1.08);
  const amazon = round2(chewyPrice * 1.12);
  const amazonSS = round2(amazon * 0.85);
  const petsmart = round2(chewyPrice * 1.15);
  const now = new Date().toISOString();

  return [
    {
      upc: product.upc,
      store: 'walmart',
      price: walmart,
      autoship_price: null,
      subscribe_save_price: null,
      in_stock: true,
      affiliate_url: `https://walmart.com/ip/${s}`,
      updated_at: now,
    },
    {
      upc: product.upc,
      store: 'amazon',
      price: amazon,
      autoship_price: null,
      subscribe_save_price: amazonSS,
      in_stock: true,
      affiliate_url: `https://amazon.com/dp/PLACEHOLDER?tag=${AMAZON_PARTNER_TAG}`,
      updated_at: now,
    },
    {
      upc: product.upc,
      store: 'petsmart',
      price: petsmart,
      autoship_price: null,
      subscribe_save_price: null,
      in_stock: true,
      affiliate_url: `https://petsmart.com/product/${s}`,
      updated_at: now,
    },
  ];
}

async function run() {
  // Load products and their existing Chewy prices.
  const { data: products, error: prodErr } = await supabase
    .from('products')
    .select('upc, name');
  if (prodErr) throw prodErr;

  const { data: chewyPrices, error: priceErr } = await supabase
    .from('prices')
    .select('upc, price')
    .eq('store', 'chewy');
  if (priceErr) throw priceErr;

  const chewyByUpc = new Map(chewyPrices.map((p) => [p.upc, Number(p.price)]));

  let seeded = 0;
  const skipped = [];
  const rows = [];

  for (const product of products) {
    const chewyPrice = chewyByUpc.get(product.upc);
    if (chewyPrice == null) {
      skipped.push(product.upc);
      console.warn(`[SKIP] ${product.upc} has no Chewy price to derive from.`);
      continue;
    }
    rows.push(...buildRows(product, chewyPrice));
    seeded += 1;
  }

  if (rows.length) {
    const { error } = await supabase
      .from('prices')
      .upsert(rows, { onConflict: 'upc,store' });
    if (error) throw error;
  }

  // Confirmation: count distinct stores per product.
  const { data: allPrices, error: allErr } = await supabase
    .from('prices')
    .select('upc, store');
  if (allErr) throw allErr;

  const storesByUpc = new Map();
  for (const row of allPrices) {
    if (!storesByUpc.has(row.upc)) storesByUpc.set(row.upc, new Set());
    storesByUpc.get(row.upc).add(row.store);
  }

  console.log('\n--- Multi-store seed summary ---');
  console.log(`Products seeded with 3 new stores: ${seeded}`);
  console.log(`Skipped (no Chewy price):          ${skipped.length}`);
  console.log(`Total price rows in DB:            ${allPrices.length}\n`);

  let fourStoreCount = 0;
  for (const [upc, stores] of storesByUpc) {
    if (stores.size >= 4) fourStoreCount += 1;
    console.log(`  ${upc}  → ${stores.size} stores: ${[...stores].sort().join(', ')}`);
  }
  console.log(
    `\n${fourStoreCount} product(s) now have prices from 4 stores ` +
      '(chewy, walmart, amazon, petsmart).'
  );
}

run().catch((err) => {
  console.error('[FATAL] seed-multistore:', err.message);
  process.exit(1);
});

/**
 * import-amazon.js
 *
 * Fetches an Amazon price for every product UPC in the `products` table using
 * the Amazon Product Advertising API v5 (PA-API) via the official
 * `paapi5-nodejs-sdk` package, and upserts into `prices` with store = 'amazon'.
 *
 * A 1-second delay is inserted between calls to respect PA-API's strict TPS
 * limits (new associate accounts start at ~1 request/sec).
 *
 * Environment (see .env.example):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   - required
 *   AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY      - required PA-API credentials
 *   AMAZON_PARTNER_TAG                        - required associates tag (e.g. name-20)
 *   AMAZON_REGION                             - optional, defaults to us-east-1
 *
 * If any Amazon credential is missing the script logs which ones and exits
 * gracefully (code 0) without crashing.
 *
 * NOTE on Subscribe & Save: PA-API v5 does not expose a dedicated "Subscribe &
 * Save" flag. We approximate it by scanning the offer listings for one whose
 * ProgramEligibility / SavingBasis indicates a recurring-delivery discount; if
 * none is found, subscribe_save_price is left null. This is documented so it
 * can be revisited if Amazon changes the schema.
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const {
  AMAZON_ACCESS_KEY,
  AMAZON_SECRET_KEY,
  AMAZON_PARTNER_TAG,
  AMAZON_REGION = 'us-east-1',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '[ERROR] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

// --- graceful credential checks (report exactly which are missing) -------
const missing = [];
if (!AMAZON_ACCESS_KEY) missing.push('AMAZON_ACCESS_KEY');
if (!AMAZON_SECRET_KEY) missing.push('AMAZON_SECRET_KEY');
if (!AMAZON_PARTNER_TAG) missing.push('AMAZON_PARTNER_TAG');
if (missing.length) {
  console.error(
    `[ERROR] Missing Amazon credential(s): ${missing.join(', ')} — skipping ` +
      'Amazon import.\n        Find them in Associates Central → Tools → ' +
      'Product Advertising API.'
  );
  process.exit(0); // graceful skip
}

// Map PA-API region → host. US marketplace uses webservices.amazon.com.
const REGION_HOST = {
  'us-east-1': 'webservices.amazon.com',
  'us-west-2': 'webservices.amazon.com',
  'eu-west-1': 'webservices.amazon.co.uk',
  'us-east-2': 'webservices.amazon.com',
};
const HOST = REGION_HOST[AMAZON_REGION] || 'webservices.amazon.com';
// PA-API SDK expects a coarse region string; US marketplaces use us-east-1.
const PAAPI_REGION = HOST.endsWith('.co.uk') ? 'eu-west-1' : 'us-east-1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- lazy-load the SDK so a missing package produces a clear message -----
let ProductAdvertisingAPIv1;
try {
  ProductAdvertisingAPIv1 = require('paapi5-nodejs-sdk');
} catch (_e) {
  console.error(
    "[ERROR] The 'paapi5-nodejs-sdk' package is not installed. Run " +
      '`npm install` (it is listed in package.json dependencies).'
  );
  process.exit(1);
}

function buildApi() {
  const client = ProductAdvertisingAPIv1.ApiClient.instance;
  client.accessKey = AMAZON_ACCESS_KEY;
  client.secretKey = AMAZON_SECRET_KEY;
  client.host = HOST;
  client.region = PAAPI_REGION;
  return new ProductAdvertisingAPIv1.DefaultApi();
}

function buildRequest(upc) {
  const req = new ProductAdvertisingAPIv1.SearchItemsRequest();
  req.Keywords = upc;
  req.SearchIndex = 'PetSupplies';
  req.PartnerTag = AMAZON_PARTNER_TAG;
  req.PartnerType = 'Associates';
  req.Resources = [
    'Offers.Listings.Price',
    'Offers.Listings.DeliveryInfo.IsPrimeEligible',
    'Offers.Summaries.LowestPrice',
    'Images.Primary.Medium',
    'ItemInfo.Title',
  ];
  return req;
}

// Promisified searchItems (the SDK uses a node-style callback).
function searchItems(api, req) {
  return new Promise((resolve, reject) => {
    api.searchItems(req, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/** Parse the first item from a SearchItems response, or null. */
function parseItem(data) {
  const items = data?.SearchResult?.Items;
  if (!items || items.length === 0) return null;
  const item = items[0];

  const listings = item?.Offers?.Listings ?? [];
  const summaries = item?.Offers?.Summaries ?? [];

  // Lowest price: prefer the Offers summary, fall back to the cheapest listing.
  let price = null;
  const lowestSummary = summaries.find((s) => s?.LowestPrice?.Amount != null);
  if (lowestSummary) {
    price = lowestSummary.LowestPrice.Amount;
  } else if (listings.length) {
    price = Math.min(
      ...listings
        .map((l) => l?.Price?.Amount)
        .filter((a) => a != null)
    );
  }
  if (price == null || !isFinite(price)) return null;

  // Prime eligibility → treat as in stock.
  const inStock = listings.some(
    (l) => l?.DeliveryInfo?.IsPrimeEligible === true
  );

  // Subscribe & Save approximation (see file header note).
  let subscribeSave = null;
  const ssListing = listings.find(
    (l) =>
      l?.ProgramEligibility?.IsSubscribeAndSaveEligible === true ||
      l?.SavingBasis?.SavingBasisType === 'SUBSCRIBE_AND_SAVE'
  );
  if (ssListing?.Price?.Amount != null) subscribeSave = ssListing.Price.Amount;

  // Canonical affiliate URL: amazon.com/dp/{asin}?tag={partner tag}
  const tag = AMAZON_PARTNER_TAG || 'bestbowl0a-20';
  const affiliateUrl = item?.ASIN
    ? `https://www.amazon.com/dp/${item.ASIN}?tag=${tag}`
    : item?.DetailPageURL ?? null;

  return {
    price,
    subscribe_save_price: subscribeSave,
    affiliate_url: affiliateUrl,
    in_stock: inStock,
  };
}

async function fetchUpcs() {
  const { data, error } = await supabase.from('products').select('upc');
  if (error) throw error;
  return data.map((r) => r.upc);
}

async function upsertPrice(upc, parsed) {
  const { data: existing, error: selErr } = await supabase
    .from('prices')
    .select('id')
    .eq('upc', upc)
    .eq('store', 'amazon')
    .maybeSingle();
  if (selErr) throw selErr;

  const { error } = await supabase.from('prices').upsert(
    {
      upc,
      store: 'amazon',
      price: parsed.price,
      autoship_price: null, // Amazon uses subscribe & save, not autoship
      subscribe_save_price: parsed.subscribe_save_price,
      in_stock: parsed.in_stock,
      affiliate_url: parsed.affiliate_url,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'upc,store' }
  );
  if (error) throw error;
  return existing ? 'updated' : 'inserted';
}

async function run() {
  const api = buildApi();
  const upcs = await fetchUpcs();
  console.log(`[amazon] ${upcs.length} product UPC(s) to look up.\n`);

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const upc of upcs) {
    processed += 1;
    try {
      const data = await searchItems(api, buildRequest(upc));
      const parsed = parseItem(data);
      if (!parsed) {
        skipped += 1;
        console.log(`[SKIP] No Amazon result for UPC: ${upc}`);
      } else {
        const action = await upsertPrice(upc, parsed);
        if (action === 'inserted') inserted += 1;
        else updated += 1;
        console.log(`[amazon] ${action} ${upc}  $${parsed.price}`);
      }
    } catch (err) {
      // PA-API returns structured errors; surface a readable message.
      const message =
        err?.response?.text || err?.message || JSON.stringify(err);
      errors.push({ upc, message });
      console.error(`[ERROR] ${upc}: ${message}`);
    }
    await sleep(1000); // respect the ~1 req/sec rate limit
  }

  console.log('\n--- Amazon import summary ---');
  console.log(`Processed: ${processed}`);
  console.log(`Inserted:  ${inserted}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Errors:    ${errors.length}`);
  console.log(
    '__SUMMARY__ ' +
      JSON.stringify({ store: 'amazon', processed, inserted, updated, skipped, errors: errors.length })
  );
}

run().catch((err) => {
  console.error('[FATAL] amazon import:', err.message);
  process.exit(1);
});

# BestBowl

BestBowl is a mobile app (Expo / React Native) that **compares pet food prices
across Chewy, Amazon, Walmart, and PetSmart** and gives every product a
**quality score** based on its ingredients and FDA recall history — so you can
find the best *value*, not just the lowest price.

This repository contains the **backend foundation**:

- a Supabase (PostgreSQL) schema,
- per-store price importers (Chewy, Walmart, Amazon, PetSmart) + a master runner,
- an ingredient/recall quality scorer,
- a `search` Supabase Edge Function that powers in-app search,
- a nightly price-refresh schedule (pg_cron → Vercel serverless function).

## Tech stack

- **Expo (React Native)** — mobile app (not yet in this repo)
- **Supabase** — PostgreSQL database + Edge Functions + pg_cron
- **Node.js** — data import / scoring scripts
- **Vercel** — serverless endpoint that the nightly cron calls

## Project layout

```
.
├── api/
│   └── refresh-prices.js      # Vercel function the nightly cron POSTs to
├── scripts/
│   ├── import-chewy.js        # Chewy feed → products + prices (store=chewy)
│   ├── import-walmart.js      # Walmart Open API → prices (store=walmart)
│   ├── import-amazon.js       # Amazon PA-API v5 → prices (store=amazon)
│   ├── import-petsmart.js     # Rainforest API → prices (store=petsmart)
│   ├── import-all.js          # runs all four importers in sequence (nightly job)
│   ├── seed-multistore.js     # mock Walmart/Amazon/PetSmart prices for testing
│   ├── score-quality.js       # computes quality_scores for each product
│   └── mock-chewy-data.json   # 10 sample products (used when CHEWY_FEED_URL unset)
├── supabase/
│   ├── migrations/
│   │   ├── 0001_initial_schema.sql
│   │   └── 0002_scheduled_refresh.sql   # pg_cron nightly refresh
│   └── functions/
│       └── search/index.ts    # GET search endpoint (multi-store value scoring)
├── .env.example
├── package.json
└── README.md
```

## Database schema

| Table              | Purpose                                                        |
| ------------------ | ------------------------------------------------------------- |
| `products`         | One row per product, keyed by UPC.                            |
| `prices`           | One row per (UPC, store). Unique on `(upc, store)` for upsert.|
| `quality_scores`   | One row per UPC: ingredient / safety / AAFCO / overall score. |
| `restock_trackers` | User restock reminders (user_id nullable until auth lands).   |

Row Level Security is enabled on every table with a permissive *allow all reads*
policy. There are intentionally **no write policies**, so the data scripts write
using the **service role key**, which bypasses RLS.

## Environment variables

Copy `.env.example` to `.env` and fill it in. Where to get each key:

| Variable | Required for | Where to get it |
| --- | --- | --- |
| `SUPABASE_URL` | everything | Supabase Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY` | search / client | same page (public anon key) |
| `SUPABASE_SERVICE_ROLE_KEY` | all importers + scorer + seed | same page (**secret** — never ship in the app) |
| `CHEWY_FEED_URL` | Chewy import (optional) | Chewy affiliate program. If unset, uses `scripts/mock-chewy-data.json` |
| `WALMART_API_KEY` | Walmart import | Free, instant approval at <https://developer.walmart.com> → "Get Started" under **Open API** |
| `AMAZON_ACCESS_KEY` | Amazon import | Associates Central → Tools → **Product Advertising API** |
| `AMAZON_SECRET_KEY` | Amazon import | same location as the access key |
| `AMAZON_PARTNER_TAG` | Amazon import | your Associates store ID, format `yourname-20` |
| `AMAZON_REGION` | Amazon import | marketplace region, default `us-east-1` |
| `RAINFOREST_API_KEY` | PetSmart import | <https://rainforestapi.com> — pay as you go, ~$0.002/request |
| `CRON_SECRET` | nightly refresh | generate with `openssl rand -hex 32`; set the same value in Supabase + Vercel |

## Local setup

```bash
npm install
cp .env.example .env   # then fill in the values above
```

Apply the database schema to a fresh project (the hosted project already has it):

```bash
supabase db push        # or paste supabase/migrations/*.sql into the SQL editor
```

## Running the importers

Each importer reads all UPCs from `products`, looks up that store, and upserts
into `prices`. Missing API keys cause a **graceful skip** (no crash). Run one at
a time:

```bash
npm run import:chewy      # Chewy feed (or mock data) — no API key needed
npm run import:walmart    # needs WALMART_API_KEY
npm run import:amazon     # needs AMAZON_ACCESS_KEY / SECRET_KEY / PARTNER_TAG (1s/UPC rate limit)
npm run import:petsmart   # needs RAINFOREST_API_KEY
```

…or run them all in sequence (Chewy → Walmart → Amazon → PetSmart). This is the
script the nightly schedule runs; it skips any store whose keys are missing and
prints a final table of how many price rows each store upserted:

```bash
npm run import:all
```

## Seeding multi-store test data

To test multi-store search **right now** without real API keys, generate mock
Walmart / Amazon / PetSmart prices derived from each product's Chewy price
(Walmart = Chewy × 1.08, Amazon = Chewy × 1.12 with subscribe&save = ×0.85,
PetSmart = Chewy × 1.15):

```bash
npm run seed:multistore
```

After it runs, every product has prices from 4 stores.

## Running the quality scorer

Scores every product with no score yet, or whose score is older than 7 days, and
upserts into `quality_scores`:

```bash
npm run score:quality
```

Scoring breakdown (max **10**): Ingredient (0–5) + Safety (0–3) + AAFCO (0–2).

## Nightly price refresh

`supabase/migrations/0002_scheduled_refresh.sql` schedules a **pg_cron** job
`nightly-price-refresh` at **02:00 UTC** that uses `pg_net` to POST to a Vercel
serverless function, `api/refresh-prices.js`. That function:

1. Verifies the `x-cron-secret` header against `CRON_SECRET`,
2. runs `import:all` (all four importers, skipping any with missing keys),
3. returns a JSON summary of what was upserted.

Postgres never holds the store API keys — they live in the Vercel environment.
Before enabling, set these once (service role / SQL editor) so the cron knows
where to POST and how to authenticate:

```sql
ALTER DATABASE postgres SET app.vercel_url  = 'https://<your-app>.vercel.app';
ALTER DATABASE postgres SET app.cron_secret = '<same value as CRON_SECRET>';
```

> The migration file is committed but **not yet applied** to the hosted project,
> because it requires a deployed Vercel URL first — otherwise the job would fail
> nightly. Apply it (`supabase db push`) once `api/refresh-prices.js` is live on
> Vercel and the settings above are set.

## The search endpoint

```
GET https://<project-ref>.supabase.co/functions/v1/search
```

Query params:

| Param | Values | Notes |
| --- | --- | --- |
| `q` | text | matches `name` OR `brand` (ILIKE `%q%`) |
| `pet_type` | `dog` \| `cat` | optional; maps to category prefix |
| `life_stage` | `puppy` \| `adult` \| `senior` \| `all_life_stages` | optional |
| `sort` | `value` (default) \| `price` \| `quality` | how results are ordered |
| `store` | `chewy` \| `amazon` \| `walmart` \| `petsmart` \| … | only products carried by that store |

```bash
curl -s "https://<project-ref>.supabase.co/functions/v1/search?q=chicken&pet_type=dog&sort=value" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" | jq
```

Response shape:

```json
{
  "meta": {
    "total_results": 2,
    "query": "chicken",
    "pet_type": "dog",
    "sort": "value",
    "store": null,
    "stores_checked": ["amazon", "chewy", "petsmart", "walmart"]
  },
  "results": [
    {
      "upc": "859610005478",
      "name": "Blue Buffalo Life Protection Formula Adult Chicken & Brown Rice",
      "brand": "Blue Buffalo",
      "image_url": "https://placehold.co/200x200",
      "quality_score": 8,
      "price_count": 4,
      "cheapest_option": 46.73,
      "savings_vs_most_expensive": 16.5,
      "prices": [
        {
          "store": "chewy",
          "price": 54.98,
          "autoship_price": 46.73,
          "subscribe_save_price": null,
          "effective_price": 46.73,
          "value_score": 9,
          "affiliate_url": "https://chewy.com/blue-buffalo-life-protection"
        }
      ],
      "best_price_store": "chewy",
      "best_price": 46.73,
      "best_value_store": "chewy",
      "best_value_score": 9
    }
  ]
}
```

> `value_score = quality_score * 0.5 + price_score * 0.5`, where
> `price_score = 10 - ((effective_price - min_price) / (max_price - min_price + 0.01)) * 5`
> compares each store's effective price (autoship → subscribe&save → price)
> across all stores carrying that product. Prices within a product are sorted by
> `value_score` so the best store shows first.

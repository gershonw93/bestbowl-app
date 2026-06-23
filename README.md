# BestBowl

BestBowl is a mobile app (Expo / React Native) that **compares pet food prices
across Chewy, Amazon, and Walmart** and gives every product a **quality score**
based on its ingredients and FDA recall history — so you can find the best
*value*, not just the lowest price.

This repository contains the **backend foundation**:

- a Supabase (PostgreSQL) schema,
- a Chewy product-feed import script,
- an ingredient/recall quality scorer,
- a `search` Supabase Edge Function that powers in-app search.

## Tech stack

- **Expo (React Native)** — mobile app (not yet in this repo)
- **Supabase** — PostgreSQL database + Edge Functions
- **Node.js** — data import / scoring scripts

## Project layout

```
.
├── scripts/
│   ├── import-chewy.js        # imports the Chewy feed into products + prices
│   ├── score-quality.js       # computes quality_scores for each product
│   └── mock-chewy-data.json   # 10 sample products (used when CHEWY_FEED_URL is unset)
├── supabase/
│   ├── migrations/
│   │   └── 0001_initial_schema.sql
│   └── functions/
│       └── search/index.ts    # GET search endpoint
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

Row Level Security is **enabled on every table** with a permissive *allow all
reads* policy for now. There are intentionally **no write policies**, so the
data scripts write using the **service role key**, which bypasses RLS. Policies
will be tightened once authentication is added.

A helper SQL function `calculate_days_remaining(bag_size_lbs, daily_serving_cups,
purchase_date)` is used by the scheduled restock job.

## Local setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Fill in `.env`:

   - `SUPABASE_URL` — e.g. `https://<project-ref>.supabase.co`
   - `SUPABASE_ANON_KEY` — public anon key (read-only under RLS)
   - `SUPABASE_SERVICE_ROLE_KEY` — **required to run the import / scorer**
     (write access). Find it in *Supabase Dashboard → Project Settings → API*.
     Keep it secret; never ship it in the mobile app.
   - `CHEWY_FEED_URL` — optional. If unset, the importer uses
     `scripts/mock-chewy-data.json`.

3. **Apply the database schema** (already applied to the hosted project; run this
   for a fresh/local project)

   ```bash
   # via the Supabase CLI
   supabase db push
   # or paste supabase/migrations/0001_initial_schema.sql into the SQL editor
   ```

## Running the import script

Imports the Chewy feed (or the mock data) and upserts into `products` and
`prices` (store = `chewy`):

```bash
npm run import:chewy
```

Output reports how many products were processed, inserted, updated, and any
errors.

## Running the quality scorer

Scores every product that has no score yet, or whose score is older than 7 days,
and upserts into `quality_scores`:

```bash
npm run score:quality
```

Scoring breakdown (max **10**):

- **Ingredient (0–5)** — named meat first ingredient (2) / meat meal (1);
  protein > 30% (1.5), 25–30% (1); no corn/wheat/soy in top 5 (1) / one (0.5);
  no artificial preservatives (0.5).
- **Safety (0–3)** — 0 recalls in 5 yrs (3) / 1 recall (1.5) / 2+ (0).
- **AAFCO (0–2)** — AAFCO statement present (2).

## Testing the search endpoint

The `search` function is deployed at:

```
https://<project-ref>.supabase.co/functions/v1/search
```

Query params: `q` (search text), `pet_type` (`dog`|`cat`, optional),
`life_stage` (optional).

```bash
curl -s "https://<project-ref>.supabase.co/functions/v1/search?q=chicken&pet_type=dog" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" | jq
```

It returns each matching product with all store prices, a per-store
`value_score`, the best price and best value, sorted by `best_value_score`
descending:

```json
{
  "results": [
    {
      "upc": "859610005478",
      "name": "Blue Buffalo Life Protection Formula Adult Chicken & Brown Rice",
      "brand": "Blue Buffalo",
      "image_url": "https://placehold.co/200x200",
      "quality_score": 8,
      "prices": [
        {
          "store": "chewy",
          "price": 54.98,
          "autoship_price": 46.73,
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
> `price_score = 10 - ((price - min_price) / (max_price - min_price)) * 5`
> across all stores carrying that product (the lowest of regular / autoship /
> subscribe&save is used as each store's effective price).

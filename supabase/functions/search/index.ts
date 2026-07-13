// BestBowl search Edge Function (v2 — multi-store value scoring)
//
// GET /functions/v1/search
//   ?q=<text>              search name OR brand (ILIKE %q%)
//   &pet_type=<dog|cat>    optional, maps to category prefix dog_/cat_
//   &life_stage=<stage>    optional
//   &sort=<value|price|quality>   optional, default 'value'
//   &store=<store>         optional, only products carried by that store
//
// For each product it joins all `prices` rows + the `quality_scores` row,
// computes a per-store value_score by comparing the *effective* price
// (autoship → subscribe&save → price) ACROSS all stores for that product, and
// returns best price / best value plus extra comparison fields.
//
// Deployed with --no-verify-jwt so the app can call it with the anon key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const round2 = (n: number) => Math.round(n * 100) / 100;

// Pet type derived from the category prefix (dog_dry -> dog, cat_wet -> cat).
const petTypeOf = (category: string | null): string | null => {
  if (!category) return null;
  if (category.startsWith("dog")) return "dog";
  if (category.startsWith("cat")) return "cat";
  return null;
};

interface PriceRow {
  upc: string;
  store: string;
  price: number | null;
  autoship_price: number | null;
  subscribe_save_price: number | null;
  in_stock: boolean;
  affiliate_url: string | null;
}

// Effective price = the price a shopper actually pays: autoship beats
// subscribe&save beats the regular price (per the spec's || precedence).
const effective = (p: PriceRow): number =>
  Number(p.autoship_price || p.subscribe_save_price || p.price);

// Tie-break for the "BEST"/Grab-it store when the effective price is EXACTLY
// equal across stores: promote the one that pays the best commission (a true
// tie is free money either way). Lower index = higher priority. Ordered by
// rough pet commission — adjust to your live affiliate rates:
//   Amazon ~3%  >  Walmart  >  PetSmart  >  Chewy ~1%
const STORE_PRIORITY = ["amazon", "walmart", "petsmart", "chewy"];
const storeRank = (s: string): number => {
  const i = STORE_PRIORITY.indexOf(String(s || "").toLowerCase());
  return i === -1 ? STORE_PRIORITY.length : i;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const petType = url.searchParams.get("pet_type"); // 'dog' | 'cat' | null
  const lifeStage = url.searchParams.get("life_stage");
  const brand = url.searchParams.get("brand");
  const sort = (url.searchParams.get("sort") ?? "value").toLowerCase();
  const storeFilter = url.searchParams.get("store");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  // ---- products query ----
  let productQuery = supabase
    .from("products")
    .select("upc, name, brand, image_url, category, life_stage");

  if (q) productQuery = productQuery.or(`name.ilike.%${q}%,brand.ilike.%${q}%`);
  if (petType === "dog" || petType === "cat") {
    productQuery = productQuery.like("category", `${petType}_%`);
  }
  if (lifeStage) productQuery = productQuery.eq("life_stage", lifeStage);
  if (brand) productQuery = productQuery.ilike("brand", `%${brand}%`);

  const { data: products, error: productErr } = await productQuery;
  if (productErr) return json({ error: productErr.message }, 500);

  const meta = {
    total_results: 0,
    query: q,
    pet_type: petType,
    life_stage: lifeStage,
    brand,
    sort,
    store: storeFilter,
    stores_checked: [] as string[],
  };

  if (!products || products.length === 0) {
    return json({ meta, results: [] });
  }

  const upcs = products.map((p) => p.upc);

  // ---- prices + quality_scores ----
  // prices + quality_scores + ingredients (joined client-side by upc)
  const [
    { data: prices, error: priceErr },
    { data: scores, error: scoreErr },
    { data: ingredients, error: ingErr },
  ] = await Promise.all([
    supabase
      .from("prices")
      .select(
        "upc, store, price, autoship_price, subscribe_save_price, in_stock, affiliate_url",
      )
      .in("upc", upcs),
    supabase
      .from("quality_scores")
      .select(
        "upc, overall_score, ingredient_score, safety_score, aafco_score, first_ingredient, protein_percent, recall_count",
      )
      .in("upc", upcs),
    supabase
      .from("ingredients")
      .select("upc, first_ingredient, protein_percent")
      .in("upc", upcs),
  ]);
  if (priceErr) return json({ error: priceErr.message }, 500);
  if (scoreErr) return json({ error: scoreErr.message }, 500);
  if (ingErr) return json({ error: ingErr.message }, 500);

  const pricesByUpc = new Map<string, PriceRow[]>();
  for (const row of (prices ?? []) as PriceRow[]) {
    if (!pricesByUpc.has(row.upc)) pricesByUpc.set(row.upc, []);
    pricesByUpc.get(row.upc)!.push(row);
  }
  // deno-lint-ignore no-explicit-any
  const scoreByUpc = new Map<string, any>();
  for (const row of scores ?? []) scoreByUpc.set(row.upc, row);
  // Presence of an ingredients row means the score used real OPFF data.
  // deno-lint-ignore no-explicit-any
  const ingByUpc = new Map<string, any>();
  for (const row of ingredients ?? []) ingByUpc.set(row.upc, row);

  const storesChecked = new Set<string>();

  // ---- assemble results ----
  let results = products.map((product) => {
    const productPrices = pricesByUpc.get(product.upc) ?? [];
    const qs = scoreByUpc.get(product.upc);
    const ing = ingByUpc.get(product.upc);
    const qualityScore = qs ? Number(qs.overall_score) : 0;

    // Compare effective prices across all stores for this product.
    const allPrices = productPrices.map(effective);
    const minPrice = allPrices.length ? Math.min(...allPrices) : 0;
    const maxPrice = allPrices.length ? Math.max(...allPrices) : 0;

    // +0.01 guard avoids divide-by-zero when every store is the same price.
    const priceScore = (p: PriceRow) =>
      10 - ((effective(p) - minPrice) / (maxPrice - minPrice + 0.01)) * 5;

    const valueScore = (price: PriceRow) =>
      round2(qualityScore * 0.5 + priceScore(price) * 0.5);

    let pricesOut = productPrices.map((p) => {
      storesChecked.add(p.store);
      return {
        store: p.store,
        price: p.price,
        autoship_price: p.autoship_price,
        subscribe_save_price: p.subscribe_save_price,
        in_stock: p.in_stock,
        effective_price: round2(effective(p)),
        value_score: valueScore(p),
        affiliate_url: p.affiliate_url,
      };
    });

    // Best store first; on an exact tie, the higher-commission store wins.
    pricesOut.sort((a, b) =>
      (b.value_score - a.value_score) || (storeRank(a.store) - storeRank(b.store))
    );

    const cheapest = allPrices.length ? round2(minPrice) : null;
    const savings =
      allPrices.length > 1 ? round2(maxPrice - minPrice) : 0;

    // Best price store (lowest effective price).
    let bestPriceStore: string | null = null;
    let bestPrice: number | null = null;
    for (const p of productPrices) {
      const eff = round2(effective(p));
      if (
        bestPrice == null || eff < bestPrice ||
        (eff === bestPrice && storeRank(p.store) < storeRank(bestPriceStore!))
      ) {
        bestPrice = eff;
        bestPriceStore = p.store;
      }
    }

    const best = pricesOut[0] ?? null;

    return {
      upc: product.upc,
      name: product.name,
      brand: product.brand,
      image_url: product.image_url,
      category: product.category,
      pet_type: petTypeOf(product.category),
      quality_score: qualityScore,
      score_breakdown: qs
        ? {
            ingredient_score: qs.ingredient_score != null ? Number(qs.ingredient_score) : null,
            safety_score: qs.safety_score != null ? Number(qs.safety_score) : null,
            aafco_score: qs.aafco_score != null ? Number(qs.aafco_score) : null,
            overall_quality: qualityScore,
            // prefer real ingredient values when an OPFF row exists
            first_ingredient: ing?.first_ingredient ?? qs.first_ingredient ?? null,
            protein_percent:
              ing?.protein_percent != null
                ? Number(ing.protein_percent)
                : qs.protein_percent != null
                ? Number(qs.protein_percent)
                : null,
            recall_count: qs.recall_count != null ? Number(qs.recall_count) : 0,
            data_source: ing ? "real" : "mock",
          }
        : null,
      price_count: productPrices.length,
      cheapest_option: cheapest,
      savings_vs_most_expensive: savings,
      prices: pricesOut,
      best_price_store: bestPriceStore,
      best_price: bestPrice,
      best_value_store: best ? best.store : null,
      best_value_score: best ? best.value_score : null,
    };
  });

  // ---- optional store filter: only products carried by that store ----
  if (storeFilter) {
    results = results.filter((r) =>
      r.prices.some((p) => p.store === storeFilter)
    );
  }

  // ---- sort results ----
  if (sort === "price") {
    // cheapest products first
    results.sort(
      (a, b) =>
        (a.cheapest_option ?? Infinity) - (b.cheapest_option ?? Infinity),
    );
  } else if (sort === "quality") {
    results.sort((a, b) => b.quality_score - a.quality_score);
  } else {
    // default: best value first
    results.sort(
      (a, b) => (b.best_value_score ?? 0) - (a.best_value_score ?? 0),
    );
  }

  meta.total_results = results.length;
  meta.stores_checked = [...storesChecked].sort();

  return json({ meta, results });
});

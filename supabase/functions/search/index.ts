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

  const { data: products, error: productErr } = await productQuery;
  if (productErr) return json({ error: productErr.message }, 500);

  const meta = {
    total_results: 0,
    query: q,
    pet_type: petType,
    life_stage: lifeStage,
    sort,
    store: storeFilter,
    stores_checked: [] as string[],
  };

  if (!products || products.length === 0) {
    return json({ meta, results: [] });
  }

  const upcs = products.map((p) => p.upc);

  // ---- prices + quality_scores ----
  const [{ data: prices, error: priceErr }, { data: scores, error: scoreErr }] =
    await Promise.all([
      supabase
        .from("prices")
        .select(
          "upc, store, price, autoship_price, subscribe_save_price, in_stock, affiliate_url",
        )
        .in("upc", upcs),
      supabase.from("quality_scores").select("upc, overall_score").in("upc", upcs),
    ]);
  if (priceErr) return json({ error: priceErr.message }, 500);
  if (scoreErr) return json({ error: scoreErr.message }, 500);

  const pricesByUpc = new Map<string, PriceRow[]>();
  for (const row of (prices ?? []) as PriceRow[]) {
    if (!pricesByUpc.has(row.upc)) pricesByUpc.set(row.upc, []);
    pricesByUpc.get(row.upc)!.push(row);
  }
  const scoreByUpc = new Map<string, number>();
  for (const row of scores ?? []) scoreByUpc.set(row.upc, Number(row.overall_score));

  const storesChecked = new Set<string>();

  // ---- assemble results ----
  let results = products.map((product) => {
    const productPrices = pricesByUpc.get(product.upc) ?? [];
    const qualityScore = scoreByUpc.get(product.upc) ?? 0;

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

    // Best store first.
    pricesOut.sort((a, b) => b.value_score - a.value_score);

    const cheapest = allPrices.length ? round2(minPrice) : null;
    const savings =
      allPrices.length > 1 ? round2(maxPrice - minPrice) : 0;

    // Best price store (lowest effective price).
    let bestPriceStore: string | null = null;
    let bestPrice: number | null = null;
    for (const p of productPrices) {
      const eff = effective(p);
      if (bestPrice == null || eff < bestPrice) {
        bestPrice = round2(eff);
        bestPriceStore = p.store;
      }
    }

    const best = pricesOut[0] ?? null;

    return {
      upc: product.upc,
      name: product.name,
      brand: product.brand,
      image_url: product.image_url,
      quality_score: qualityScore,
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

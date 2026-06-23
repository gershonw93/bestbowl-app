// BestBowl search Edge Function
//
// GET /functions/v1/search?q=<text>&pet_type=<dog|cat>&life_stage=<stage>
//
//   - Searches `products` where name OR brand ILIKE %q%
//   - Optional filters: pet_type (maps to category prefix dog_/cat_), life_stage
//   - Joins all `prices` rows and the `quality_scores` row for each product
//   - Computes a per-store value_score and returns the best price / best value
//   - Sorts results by best_value_score descending
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

// Effective price for a store = the lowest of price / autoship / subscribe&save.
function effectivePrice(p: {
  price: number | null;
  autoship_price: number | null;
  subscribe_save_price: number | null;
}): number {
  const candidates = [p.price, p.autoship_price, p.subscribe_save_price].filter(
    (v): v is number => v != null,
  );
  return candidates.length ? Math.min(...candidates) : Number(p.price);
}

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
  const lifeStage = url.searchParams.get("life_stage"); // optional

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  // ---- products query ----
  let productQuery = supabase
    .from("products")
    .select("upc, name, brand, image_url, category, life_stage");

  if (q) {
    productQuery = productQuery.or(`name.ilike.%${q}%,brand.ilike.%${q}%`);
  }
  if (petType === "dog" || petType === "cat") {
    productQuery = productQuery.like("category", `${petType}_%`);
  }
  if (lifeStage) {
    productQuery = productQuery.eq("life_stage", lifeStage);
  }

  const { data: products, error: productErr } = await productQuery;
  if (productErr) return json({ error: productErr.message }, 500);
  if (!products || products.length === 0) return json({ results: [] });

  const upcs = products.map((p) => p.upc);

  // ---- prices + quality_scores for those products ----
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

  const pricesByUpc = new Map<string, typeof prices>();
  for (const row of prices ?? []) {
    if (!pricesByUpc.has(row.upc)) pricesByUpc.set(row.upc, []);
    pricesByUpc.get(row.upc)!.push(row);
  }
  const scoreByUpc = new Map<string, number>();
  for (const row of scores ?? []) {
    scoreByUpc.set(row.upc, Number(row.overall_score));
  }

  // ---- assemble results ----
  const results = products.map((product) => {
    const productPrices = pricesByUpc.get(product.upc) ?? [];
    const qualityScore = scoreByUpc.get(product.upc) ?? 0;

    const effPrices = productPrices.map(effectivePrice);
    const minPrice = effPrices.length ? Math.min(...effPrices) : 0;
    const maxPrice = effPrices.length ? Math.max(...effPrices) : 0;
    const spread = maxPrice - minPrice;

    const pricesOut = productPrices.map((p) => {
      const eff = effectivePrice(p);
      // When every store is the same price (or only one store), no price
      // advantage exists, so price_score is the max (10).
      const priceScore = spread > 0 ? 10 - ((eff - minPrice) / spread) * 5 : 10;
      const valueScore =
        Math.round((qualityScore * 0.5 + priceScore * 0.5) * 10) / 10;
      return {
        store: p.store,
        price: p.price,
        autoship_price: p.autoship_price,
        subscribe_save_price: p.subscribe_save_price,
        in_stock: p.in_stock,
        value_score: valueScore,
        affiliate_url: p.affiliate_url,
      };
    });

    // best price (by effective price)
    let bestPriceStore: string | null = null;
    let bestPrice: number | null = null;
    productPrices.forEach((p) => {
      const eff = effectivePrice(p);
      if (bestPrice == null || eff < bestPrice) {
        bestPrice = eff;
        bestPriceStore = p.store;
      }
    });

    // best value (by value_score)
    let bestValueStore: string | null = null;
    let bestValueScore: number | null = null;
    pricesOut.forEach((p) => {
      if (bestValueScore == null || p.value_score > bestValueScore) {
        bestValueScore = p.value_score;
        bestValueStore = p.store;
      }
    });

    return {
      upc: product.upc,
      name: product.name,
      brand: product.brand,
      image_url: product.image_url,
      quality_score: qualityScore,
      prices: pricesOut,
      best_price_store: bestPriceStore,
      best_price: bestPrice,
      best_value_store: bestValueStore,
      best_value_score: bestValueScore,
    };
  });

  results.sort(
    (a, b) => (b.best_value_score ?? 0) - (a.best_value_score ?? 0),
  );

  return json({ results });
});

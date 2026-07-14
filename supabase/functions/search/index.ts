// BestBowl search Edge Function (v9 — unit price + flavor-aware compare)
//
// GET /functions/v1/search  ?q &pet_type &life_stage &sort &store
// For each product: joins prices + quality_scores, computes per-store value,
// price-per-oz, and labels sibling flavors (shown but never the headline price).
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
  pack_size_oz: number | null;
  flavor: string | null;
}

// Effective price = the price a shopper actually pays: autoship beats
// subscribe&save beats the regular price.
const effective = (p: PriceRow): number =>
  Number(p.autoship_price || p.subscribe_save_price || p.price);

// Price per ounce — the honest way to compare across pack sizes.
const unitOz = (p: PriceRow): number | null => {
  const sz = Number(p.pack_size_oz);
  return sz > 0 ? effective(p) / sz : null;
};

// Tie-break for the BEST store on an exact price tie: promote the one that pays
// the best commission. Amazon ~3% > Walmart > PetSmart > Chewy ~1%.
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
  const petType = url.searchParams.get("pet_type");
  const lifeStage = url.searchParams.get("life_stage");
  const brand = url.searchParams.get("brand");
  const sort = (url.searchParams.get("sort") ?? "value").toLowerCase();
  const storeFilter = url.searchParams.get("store");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

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

  const [
    { data: prices, error: priceErr },
    { data: scores, error: scoreErr },
    { data: ingredients, error: ingErr },
  ] = await Promise.all([
    supabase
      .from("prices")
      .select(
        "upc, store, price, autoship_price, subscribe_save_price, in_stock, affiliate_url, pack_size_oz, flavor",
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
  // deno-lint-ignore no-explicit-any
  const ingByUpc = new Map<string, any>();
  for (const row of ingredients ?? []) ingByUpc.set(row.upc, row);

  const storesChecked = new Set<string>();

  let results = products.map((product) => {
    const productPrices = pricesByUpc.get(product.upc) ?? [];
    const qs = scoreByUpc.get(product.upc);
    const ing = ingByUpc.get(product.upc);
    const qualityScore = qs ? Number(qs.overall_score) : 0;

    // Reference flavor = what THIS product is (its Amazon listing, else the first
    // priced row that names a flavor). A row whose flavor differs is a sibling
    // variant — shown & labeled, but never the headline cheapest.
    const refFlavor =
      productPrices.find((p) => p.store === "amazon" && p.flavor)?.flavor ??
      productPrices.find((p) => p.flavor)?.flavor ?? null;
    const flavorDiffers = (p: PriceRow): boolean =>
      !!(p.flavor && refFlavor && p.flavor !== refFlavor);

    const sameFlavor = productPrices.filter((p) => !flavorDiffers(p));
    const scored = sameFlavor.length ? sameFlavor : productPrices;

    const allPrices = scored.map(effective);
    const minPrice = allPrices.length ? Math.min(...allPrices) : 0;
    const maxPrice = allPrices.length ? Math.max(...allPrices) : 0;

    const priceScore = (p: PriceRow) =>
      10 - ((effective(p) - minPrice) / (maxPrice - minPrice + 0.01)) * 5;
    const valueScore = (price: PriceRow) =>
      round2(qualityScore * 0.5 + priceScore(price) * 0.5);

    let bestUnit = Infinity;
    for (const p of scored) {
      const u = unitOz(p);
      if (u != null && u < bestUnit) bestUnit = u;
    }

    let pricesOut = productPrices.map((p) => {
      storesChecked.add(p.store);
      const u = unitOz(p);
      const differs = flavorDiffers(p);
      return {
        store: p.store,
        price: p.price,
        autoship_price: p.autoship_price,
        subscribe_save_price: p.subscribe_save_price,
        in_stock: p.in_stock,
        effective_price: round2(effective(p)),
        value_score: valueScore(p),
        affiliate_url: p.affiliate_url,
        pack_size_oz: p.pack_size_oz != null ? Number(p.pack_size_oz) : null,
        unit_price_oz: u != null ? Math.round(u * 1000) / 1000 : null,
        unit_price_lb: u != null ? round2(u * 16) : null,
        flavor: p.flavor,
        flavor_differs: differs,
        best_unit: !differs && u != null && bestUnit !== Infinity &&
          Math.abs(u - bestUnit) < 1e-9,
      };
    });

    pricesOut.sort((a, b) =>
      (Number(a.flavor_differs) - Number(b.flavor_differs)) ||
      (b.value_score - a.value_score) ||
      (storeRank(a.store) - storeRank(b.store))
    );

    const cheapest = allPrices.length ? round2(minPrice) : null;
    const savings = allPrices.length > 1 ? round2(maxPrice - minPrice) : 0;

    let bestPriceStore: string | null = null;
    let bestPrice: number | null = null;
    for (const p of scored) {
      const eff = round2(effective(p));
      if (
        bestPrice == null || eff < bestPrice ||
        (eff === bestPrice && storeRank(p.store) < storeRank(bestPriceStore!))
      ) {
        bestPrice = eff;
        bestPriceStore = p.store;
      }
    }

    const best = pricesOut.find((p) => !p.flavor_differs) ?? pricesOut[0] ?? null;

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
      best_unit_price_oz: bestUnit !== Infinity ? Math.round(bestUnit * 1000) / 1000 : null,
      prices: pricesOut,
      best_price_store: bestPriceStore,
      best_price: bestPrice,
      best_value_store: best ? best.store : null,
      best_value_score: best ? best.value_score : null,
    };
  });

  // Drop products with no usable price (would render as "$NaN").
  results = results.filter((r) => r.best_price != null && r.best_price > 0);

  if (storeFilter) {
    results = results.filter((r) => r.prices.some((p) => p.store === storeFilter));
  }

  if (sort === "price") {
    results.sort((a, b) => (a.cheapest_option ?? Infinity) - (b.cheapest_option ?? Infinity));
  } else if (sort === "quality") {
    results.sort((a, b) => b.quality_score - a.quality_score);
  } else {
    results.sort((a, b) => (b.best_value_score ?? 0) - (a.best_value_score ?? 0));
  }

  meta.total_results = results.length;
  meta.stores_checked = [...storesChecked].sort();

  return json({ meta, results });
});

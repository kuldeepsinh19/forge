import type { Usage } from "../provider/types.js";

/**
 * Priced cost accounting.
 *
 * Two rules make runs reproducible:
 *
 * 1. **Prices are a dated table checked into the repository**, never fetched at runtime.
 *    Fetching at runtime silently re-prices every historical run when a vendor changes
 *    a number.
 * 2. **Cost is recomputed from stored usage fields**, so correcting a pricing mistake is
 *    a script re-run rather than re-running the evaluation.
 */

/** Per-million-token prices, in USD. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * Multiplier on base input for a cache read. Roughly 0.1 on most models, but it is a
   * per-model value: at least one model prices reads at 0.025, so this is never
   * hardcoded at the call site.
   */
  cacheReadMultiplier: number;
  /** Multiplier on base input for a cache write with the default 5-minute TTL. */
  cacheWriteMultiplier: number;
}

export interface PriceTable {
  version: string;
  models: Record<string, ModelPrice>;
}

/**
 * Prices as published on the stated date. Update by adding a new dated table rather
 * than editing this one in place, so historical runs keep their original pricing.
 */
export const PRICE_TABLE: PriceTable = {
  version: "2026-09-12",
  models: {
    "claude-opus-5": {
      inputPerMTok: 5.0,
      outputPerMTok: 25.0,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    },
    "claude-sonnet-5": {
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    },
    "claude-haiku-4-5-20251001": {
      inputPerMTok: 1.0,
      outputPerMTok: 5.0,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    },
  },
};

/** Prices used when a model is not in the table. Flagged so results stay honest. */
const UNKNOWN_MODEL_PRICE: ModelPrice = {
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

/**
 * Resolve a model id to its price, tolerating the version suffixes vendors append.
 *
 * Returns `null` when the model is unknown, so callers can record a zero cost and warn
 * rather than silently reporting a fabricated number.
 */
export function priceFor(model: string, table: PriceTable = PRICE_TABLE): ModelPrice | null {
  const exact = table.models[model];
  if (exact) return exact;
  // Vendors append dated suffixes (`claude-opus-5-20260101`); match the longest prefix.
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table.models)) {
    if (model.startsWith(key) && (best === null || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
}

/**
 * Cost of one call, in USD.
 *
 * Cache reads and cache writes are priced differently from base input, and the
 * difference dominates any honest estimate for an agent that runs many turns.
 */
export function computeCost(model: string, usage: Usage, table: PriceTable = PRICE_TABLE): number {
  const price = priceFor(model, table) ?? UNKNOWN_MODEL_PRICE;
  const inputCost = usage.inputTokens * price.inputPerMTok;
  const writeCost =
    usage.cacheCreationInputTokens * price.inputPerMTok * price.cacheWriteMultiplier;
  const readCost = usage.cacheReadInputTokens * price.inputPerMTok * price.cacheReadMultiplier;
  const outputCost = usage.outputTokens * price.outputPerMTok;
  return (inputCost + writeCost + readCost + outputCost) / 1e6;
}

/**
 * Total prompt volume, counting cached tokens.
 *
 * This is the honest answer to "how much context did this call carry". `inputTokens`
 * alone is only the uncached remainder.
 */
export function contextVolume(usage: Usage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

/**
 * Fraction of context volume served from cache, 0..1.
 *
 * This is the number that adjudicates whether context is being reused or re-sent. A
 * pipeline that re-packs freshly-composed prose for every stage cannot score well here
 * no matter how small its individual prompts are.
 */
export function cacheHitRatio(usage: Usage): number {
  const volume = contextVolume(usage);
  return volume === 0 ? 0 : usage.cacheReadInputTokens / volume;
}

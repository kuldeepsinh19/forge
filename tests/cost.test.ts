import { describe, expect, it } from "vitest";
import {
  cacheHitRatio,
  computeCost,
  contextVolume,
  priceFor,
  type PriceTable,
} from "../src/telemetry/cost.js";
import type { Usage } from "../src/provider/types.js";

/**
 * Cost accounting is the project's central measurement, so these tests pin down the two
 * things most commonly got wrong: that cache reads and writes are priced differently
 * from base input, and that `inputTokens` is not the whole prompt.
 */

const TABLE: PriceTable = {
  version: "test",
  models: {
    "test-model": {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    },
    "cheap-reads": {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadMultiplier: 0.025,
      cacheWriteMultiplier: 1.25,
    },
  },
};

const usage = (partial: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  ...partial,
});

describe("computeCost", () => {
  it("prices plain input and output at base rates", () => {
    const cost = computeCost("test-model", usage({ inputTokens: 1e6, outputTokens: 1e6 }), TABLE);
    expect(cost).toBeCloseTo(60, 6);
  });

  it("prices cache writes above base input", () => {
    const cost = computeCost("test-model", usage({ cacheCreationInputTokens: 1e6 }), TABLE);
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it("prices cache reads far below base input", () => {
    const cost = computeCost("test-model", usage({ cacheReadInputTokens: 1e6 }), TABLE);
    expect(cost).toBeCloseTo(1, 6);
  });

  it("honours a per-model cache-read multiplier rather than assuming 0.1", () => {
    // At least one real model prices reads at 0.025, so this must not be hardcoded.
    const cost = computeCost("cheap-reads", usage({ cacheReadInputTokens: 1e6 }), TABLE);
    expect(cost).toBeCloseTo(0.25, 6);
  });

  it("shows why caching dominates: same volume, different price", () => {
    const uncached = computeCost("test-model", usage({ inputTokens: 1e6 }), TABLE);
    const cached = computeCost("test-model", usage({ cacheReadInputTokens: 1e6 }), TABLE);
    expect(uncached / cached).toBeCloseTo(10, 6);
  });

  it("returns zero for an unknown model rather than inventing a price", () => {
    expect(computeCost("who-knows", usage({ inputTokens: 1e6 }), TABLE)).toBe(0);
  });

  it("matches a dated model id by longest prefix", () => {
    expect(priceFor("test-model-20260101", TABLE)?.inputPerMTok).toBe(10);
  });

  it("returns null for a model with no entry", () => {
    expect(priceFor("nonexistent", TABLE)).toBeNull();
  });
});

describe("contextVolume", () => {
  it("counts cached tokens, not just the uncached remainder", () => {
    // inputTokens alone would report 100 here, understating the prompt by 30x.
    const u = usage({
      inputTokens: 100,
      cacheCreationInputTokens: 900,
      cacheReadInputTokens: 2000,
    });
    expect(contextVolume(u)).toBe(3000);
  });

  it("is zero for an empty call", () => {
    expect(contextVolume(usage({}))).toBe(0);
  });
});

describe("cacheHitRatio", () => {
  it("is the cached share of total prompt volume", () => {
    expect(cacheHitRatio(usage({ inputTokens: 250, cacheReadInputTokens: 750 }))).toBeCloseTo(0.75);
  });

  it("is zero when nothing was cached", () => {
    expect(cacheHitRatio(usage({ inputTokens: 1000 }))).toBe(0);
  });

  it("is zero rather than NaN for an empty call", () => {
    expect(cacheHitRatio(usage({}))).toBe(0);
  });
});

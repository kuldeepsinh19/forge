import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";

/**
 * Config loading. The behaviour worth pinning down is that a bad config is an error
 * rather than a silent fallback: running with settings the user believes are different
 * from the ones in force is worse than refusing to start.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-config-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (value: unknown): void =>
  writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify(value), "utf8");

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  it("merges a partial config over the defaults", () => {
    writeConfig({ limits: { maxRevisions: 5 } });
    const config = loadConfig(root);
    expect(config.limits.maxRevisions).toBe(5);
    expect(config.limits.maxTurnsPerStage).toBe(DEFAULT_CONFIG.limits.maxTurnsPerStage);
    expect(config.models.implement).toBe(DEFAULT_CONFIG.models.implement);
  });

  it("merges nested objects rather than replacing them", () => {
    writeConfig({ models: { review: "some-other-model" } });
    const config = loadConfig(root);
    expect(config.models.review).toBe("some-other-model");
    expect(config.models.investigate).toBe(DEFAULT_CONFIG.models.investigate);
  });

  it("throws on malformed JSON instead of silently using defaults", () => {
    writeFileSync(join(root, CONFIG_FILENAME), "{ nope", "utf8");
    expect(() => loadConfig(root)).toThrow(/not valid JSON/);
  });

  it("throws with a field-level message when a value has the wrong type", () => {
    writeConfig({ limits: { maxRevisions: "lots" } });
    expect(() => loadConfig(root)).toThrow(/maxRevisions/);
  });

  it("rejects a negative revision limit", () => {
    writeConfig({ limits: { maxRevisions: -1 } });
    expect(() => loadConfig(root)).toThrow();
  });

  it("allows zero revisions, which disables the revision loop", () => {
    writeConfig({ limits: { maxRevisions: 0 } });
    expect(loadConfig(root).limits.maxRevisions).toBe(0);
  });

  it("accepts explicit null validation overrides", () => {
    writeConfig({ validation: { test: "make check", lint: null } });
    const config = loadConfig(root);
    expect(config.validation.test).toBe("make check");
    expect(config.validation.lint).toBeNull();
  });

  it("defaults review to a different model from implement", () => {
    // A reviewer sharing the implementer's model shares its blind spots.
    expect(DEFAULT_CONFIG.models.review).not.toBe(DEFAULT_CONFIG.models.implement);
  });
});

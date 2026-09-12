import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCommands, probeWorkspace } from "../src/retrieval/workspace.js";

/**
 * The workspace probe must be cheap, bounded, and *deterministic* — it is rendered into
 * the cached prompt prefix, so instability here silently destroys cache reuse.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-workspace-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (relative: string, content: string): void => {
  const full = join(root, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
};

describe("discoverCommands", () => {
  it("reads scripts from package.json and prefixes with the detected runner", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }));
    write("pnpm-lock.yaml", "");
    const commands = discoverCommands(root);
    expect(commands.test).toBe("pnpm run test");
    expect(commands.lint).toBe("pnpm run lint");
  });

  it("defaults to npm when no lockfile identifies a runner", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    expect(discoverCommands(root).test).toBe("npm run test");
  });

  it("accepts type-check as an alias for typecheck", () => {
    write("package.json", JSON.stringify({ scripts: { "type-check": "tsc --noEmit" } }));
    expect(discoverCommands(root).typecheck).toBe("npm run type-check");
  });

  it("leaves a command null rather than guessing one", () => {
    // A guessed command fails for reasons that teach nobody anything.
    write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    const commands = discoverCommands(root);
    expect(commands.lint).toBeNull();
    expect(commands.build).toBeNull();
  });

  it("recognizes non-JavaScript ecosystems", () => {
    write("Cargo.toml", "[package]\nname='x'");
    expect(discoverCommands(root).test).toBe("cargo test");
  });

  it("survives a malformed package.json without throwing", () => {
    write("package.json", "{ not json");
    expect(() => discoverCommands(root)).not.toThrow();
    expect(discoverCommands(root).test).toBeNull();
  });
});

describe("probeWorkspace", () => {
  it("detects languages, package manager and directories", () => {
    write("package.json", JSON.stringify({ scripts: {} }));
    write("package-lock.json", "{}");
    write("src/a.ts", "export const a = 1;");
    write("src/b.ts", "export const b = 2;");
    write("tests/a.test.ts", "test");

    const profile = probeWorkspace(root);
    expect(profile.languages).toContain("TypeScript");
    expect(profile.packageManager).toBe("npm");
    expect(profile.sourceDirs).toContain("src");
    expect(profile.testDirs).toContain("tests");
    expect(profile.markers).toContain("package.json");
  });

  it("produces identical output across repeated probes of the same tree", () => {
    // Stability matters more than accuracy here: the profile is part of the cache key.
    write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    write("src/a.ts", "x");
    write("src/b.py", "y");
    const first = JSON.stringify(probeWorkspace(root));
    const second = JSON.stringify(probeWorkspace(root));
    expect(first).toBe(second);
  });

  it("ignores node_modules when taking the language census", () => {
    write("src/a.ts", "x");
    for (let i = 0; i < 40; i += 1) write(`node_modules/pkg/f${i}.js`, "junk");
    const profile = probeWorkspace(root);
    expect(profile.languages[0]).toBe("TypeScript");
  });

  it("reads repository instructions when present", () => {
    write("AGENTS.md", "Use tabs, not spaces.");
    expect(probeWorkspace(root).instructions).toContain("Use tabs");
  });

  it("truncates very large instruction files", () => {
    write("AGENTS.md", "x".repeat(20_000));
    const instructions = probeWorkspace(root).instructions ?? "";
    expect(instructions.length).toBeLessThan(20_000);
    expect(instructions).toContain("[truncated]");
  });

  it("returns null instructions when the file is absent", () => {
    expect(probeWorkspace(root).instructions).toBeNull();
  });

  it("handles an empty directory without throwing", () => {
    const profile = probeWorkspace(root);
    expect(profile.languages).toEqual([]);
    expect(profile.packageManager).toBeNull();
  });
});

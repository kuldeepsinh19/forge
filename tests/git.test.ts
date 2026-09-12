import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNotProtected,
  branchNameFor,
  commitAll,
  createBranch,
  currentBranch,
  diffWorkingTree,
  GitError,
  isDirty,
  isRepository,
} from "../src/git/workspace.js";

/**
 * Git safety.
 *
 * Branch names are the one piece of git input that originates outside the program (a task
 * title), so these tests concentrate on what happens when that input is hostile, and on
 * the refusal to touch protected branches.
 */

let root: string;

const gitRaw = (args: string[]): void => {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-git-"));
  gitRaw(["init", "-q", "-b", "main"]);
  gitRaw(["config", "user.email", "test@example.com"]);
  gitRaw(["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "hello\n", "utf8");
  gitRaw(["add", "-A"]);
  gitRaw(["commit", "-q", "-m", "initial"]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("branchNameFor", () => {
  it("slugs a title and appends a short id", () => {
    const name = branchNameFor("abcdef1234567890", "Fix the checkout timeout");
    expect(name).toBe("forge/fix-the-checkout-timeout-abcdef12");
  });

  it("strips characters that do not belong in a ref", () => {
    const name = branchNameFor("abcdef1234567890", "Fix: auth/../../etc & $(whoami)");
    expect(name).toMatch(/^forge\/[a-z0-9-]+-abcdef12$/);
    expect(name).not.toContain("..");
    expect(name).not.toContain("$");
  });

  it("survives a title with no usable characters", () => {
    const name = branchNameFor("abcdef1234567890", "!!! ???");
    expect(name).toBe("forge/task-abcdef12");
  });

  it("bounds the length of a very long title", () => {
    const name = branchNameFor("abcdef1234567890", "x".repeat(500));
    expect(name.length).toBeLessThan(70);
  });

  it("honours a custom prefix", () => {
    expect(branchNameFor("abcdef1234567890", "thing", "bot")).toMatch(/^bot\//);
  });
});

describe("assertNotProtected", () => {
  it("refuses the usual protected branches", () => {
    for (const branch of ["main", "master", "develop", "trunk", "HEAD"]) {
      expect(() => assertNotProtected(branch)).toThrow(GitError);
    }
  });

  it("refuses a fully-qualified protected ref", () => {
    expect(() => assertNotProtected("refs/heads/main")).toThrow(GitError);
  });

  it("permits a feature branch", () => {
    expect(() => assertNotProtected("forge/fix-thing-abc123")).not.toThrow();
  });
});

describe("repository operations", () => {
  it("recognizes a git repository", () => {
    expect(isRepository(root)).toBe(true);
    expect(isRepository(tmpdir())).toBe(false);
  });

  it("reports a clean tree as clean and a modified tree as dirty", () => {
    expect(isDirty(root)).toBe(false);
    writeFileSync(join(root, "new.txt"), "content", "utf8");
    expect(isDirty(root)).toBe(true);
  });

  it("creates and switches to a feature branch", () => {
    createBranch(root, "forge/test-branch");
    expect(currentBranch(root)).toBe("forge/test-branch");
  });

  it("refuses to create a protected branch", () => {
    expect(() => createBranch(root, "master")).toThrow(GitError);
  });

  it("refuses a branch name containing a shell metacharacter", () => {
    expect(() => createBranch(root, "forge/x;rm -rf /")).toThrow(GitError);
  });
});

describe("commitAll", () => {
  it("commits changes on a feature branch and returns the sha", () => {
    createBranch(root, "forge/work");
    writeFileSync(join(root, "file.txt"), "content", "utf8");
    const sha = commitAll(root, "add file");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(isDirty(root)).toBe(false);
  });

  it("returns null when there is nothing to commit", () => {
    // A builder that changed nothing should be caught by review, not by an exception.
    createBranch(root, "forge/work");
    expect(commitAll(root, "nothing")).toBeNull();
  });

  it("refuses to commit while on a protected branch", () => {
    writeFileSync(join(root, "file.txt"), "content", "utf8");
    expect(() => commitAll(root, "sneaky")).toThrow(GitError);
  });
});

describe("diffWorkingTree", () => {
  it("includes modifications to tracked files", () => {
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "README.md"), "changed\n", "utf8");
    expect(diffWorkingTree(root, base)).toContain("changed");
  });

  it("includes newly created files", () => {
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "brand-new.ts"), "export const x = 1;\n", "utf8");
    const diff = diffWorkingTree(root, base);
    expect(diff).toContain("brand-new.ts");
  });

  it("is empty when nothing changed", () => {
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(diffWorkingTree(root, base).trim()).toBe("");
  });
});

describe("Forge's own artifacts", () => {
  it("keeps .forge out of the commit", () => {
    // Telemetry is written inside the repository under test. Without an explicit
    // exclusion `git add -A` sweeps it into the change, and it ends up in the pull
    // request. Caught by a real end-to-end run, so pinned here.
    createBranch(root, "forge/work");
    mkdirSync(join(root, ".forge", "runs", "x"), { recursive: true });
    writeFileSync(join(root, ".forge", "runs", "x", "requests.jsonl"), '{"a":1}\n', "utf8");
    writeFileSync(join(root, "src.txt"), "real change", "utf8");

    const sha = commitAll(root, "change");
    expect(sha).not.toBeNull();

    const committed = execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(committed).toContain("src.txt");
    expect(committed).not.toContain(".forge");
  });

  it("keeps .forge out of the diff the reviewer sees", () => {
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    mkdirSync(join(root, ".forge", "runs", "y"), { recursive: true });
    writeFileSync(join(root, ".forge", "runs", "y", "summary.json"), "{}", "utf8");
    writeFileSync(join(root, "feature.ts"), "export const x = 1;\n", "utf8");

    const diff = diffWorkingTree(root, base);
    expect(diff).toContain("feature.ts");
    expect(diff).not.toContain(".forge");
  });
});

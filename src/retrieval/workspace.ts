import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { DiscoveredCommands, WorkspaceProfile } from "../core/types.js";

/**
 * A cheap, bounded, deterministic description of a repository.
 *
 * Probed **once** per run and then frozen. Two reasons it is frozen rather than
 * refreshed:
 *
 * 1. It is rendered into the stable prefix of every prompt. If it changed between turns,
 *    the prefix would change with it and prompt caching would stop hitting, which costs
 *    far more than the staleness saves.
 * 2. None of it is expensive to be slightly wrong about. It is orientation, not evidence.
 *
 * Every operation here is bounded: the file sweep stops at a fixed entry count, the git
 * probe has a timeout, and directory recursion has a depth limit. A probe that can hang
 * on a large monorepo is not a cheap probe.
 */

/** Directories never worth walking. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "coverage",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
]);

/** Extension to language, for the coarse language census. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".php": "PHP",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
};

/** Marker files that identify a project's ecosystem. */
const MARKER_FILES = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
];

/** Lockfile to package manager. Checked in order, first match wins. */
const LOCKFILES: ReadonlyArray<[string, WorkspaceProfile["packageManager"]]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["poetry.lock", "poetry"],
  ["uv.lock", "uv"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go"],
  ["requirements.txt", "pip"],
];

/** Hard bounds so the probe stays cheap on any repository. */
const MAX_FILES_SCANNED = 4000;
const MAX_DEPTH = 6;
const GIT_TIMEOUT_MS = 2500;
const MAX_INSTRUCTIONS_CHARS = 8000;

/** Probe a repository. Cheap, bounded, and deterministic for a given tree. */
export function probeWorkspace(root: string): WorkspaceProfile {
  const files = sweep(root);
  const markers = MARKER_FILES.filter((m) => existsSync(join(root, m)));

  return {
    languages: censusLanguages(files),
    packageManager: detectPackageManager(root),
    markers,
    commands: discoverCommands(root),
    sourceDirs: pickDirs(root, ["src", "lib", "app", "packages", "internal", "cmd"]),
    testDirs: pickDirs(root, ["test", "tests", "__tests__", "spec", "e2e"]),
    instructions: readInstructions(root),
  };
}

/** Bounded breadth-first file sweep. Returns repo-relative POSIX paths. */
function sweep(root: string): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && found.length < MAX_FILES_SCANNED) {
    const next = queue.shift();
    if (!next || next.depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than fail the run
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES_SCANNED) break;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push({ dir: full, depth: next.depth + 1 });
      } else if (entry.isFile()) {
        found.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  return found;
}

/** Languages present, most common first. Only those above a 2% share are reported. */
function censusLanguages(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[extname(file)];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...counts.entries()]
    .filter(([, count]) => count / total >= 0.02)
    .sort((a, b) => b[1] - a[1])
    .map(([language]) => language);
}

function detectPackageManager(root: string): WorkspaceProfile["packageManager"] {
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(join(root, lockfile))) return manager;
  }
  return null;
}

function pickDirs(root: string, candidates: string[]): string[] {
  return candidates.filter((dir) => {
    try {
      return statSync(join(root, dir)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Discover validation commands from the repository's own configuration.
 *
 * Discovered, never guessed. A command Forge invented is a command that fails in CI and
 * teaches the agent nothing, so an absent entry stays `null` and the validator skips it.
 */
export function discoverCommands(root: string): DiscoveredCommands {
  const commands: DiscoveredCommands = { test: null, lint: null, typecheck: null, build: null };
  const packageJsonPath = join(root, "package.json");

  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = parsed.scripts ?? {};
      const runner = detectPackageManager(root) ?? "npm";
      const run = (script: string): string =>
        runner === "npm" ? `npm run ${script}` : `${runner} run ${script}`;

      if (scripts["test"]) commands.test = run("test");
      if (scripts["lint"]) commands.lint = run("lint");
      if (scripts["typecheck"]) commands.typecheck = run("typecheck");
      else if (scripts["type-check"]) commands.typecheck = run("type-check");
      if (scripts["build"]) commands.build = run("build");
    } catch {
      // Malformed package.json is the repository's problem, not a reason to abort.
    }
  }

  if (commands.test === null && existsSync(join(root, "pyproject.toml"))) {
    commands.test = "pytest";
  }
  if (commands.test === null && existsSync(join(root, "Cargo.toml"))) {
    commands.test = "cargo test";
    commands.build = commands.build ?? "cargo build";
  }
  if (commands.test === null && existsSync(join(root, "go.mod"))) {
    commands.test = "go test ./...";
    commands.build = commands.build ?? "go build ./...";
  }
  return commands;
}

/**
 * Read repository-authored agent instructions, if present.
 *
 * These are **untrusted**: `AGENTS.md` is repository content, so in a repository Forge
 * did not write it is attacker-controlled. It is truncated, and the prompt renderer
 * fences it and labels it as untrusted rather than presenting it as an instruction.
 */
function readInstructions(root: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content.length === 0) continue;
      return content.length > MAX_INSTRUCTIONS_CHARS
        ? `${content.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[truncated]`
        : content;
    } catch {
      continue;
    }
  }
  return null;
}

/** Current commit, or null outside a git repository. */
export function currentCommit(root: string): string | null {
  return git(root, ["rev-parse", "HEAD"]);
}

/** Current branch, or null when detached or outside a repository. */
export function currentBranch(root: string): string | null {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "HEAD" ? null : branch;
}

/** Run a git command with a timeout. Returns null on any failure. */
export function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

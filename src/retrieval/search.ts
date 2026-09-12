import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { resolveInsideRoot } from "./evidence.js";
import { git } from "./workspace.js";

/**
 * Deterministic repository search.
 *
 * These are the cheap operations that run *before* any model reasoning, and in most
 * cases instead of it. Everything is bounded: results are capped, file reads are
 * windowed, and output is truncated, because an unbounded tool result is how an agent
 * silently loads a megabyte of minified JavaScript into a prompt.
 *
 * ripgrep is used when available and a portable JavaScript scan is used when it is not,
 * so behaviour does not depend on what happens to be installed.
 */

const MAX_MATCHES = 60;
const MAX_LINE_CHARS = 300;
const MAX_READ_LINES = 400;
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

let ripgrepChecked = false;
let ripgrepAvailable = false;

/** Whether ripgrep is on PATH. Probed once. */
export function hasRipgrep(): boolean {
  if (!ripgrepChecked) {
    ripgrepChecked = true;
    ripgrepAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return ripgrepAvailable;
}

/**
 * Search file contents for a regular expression.
 *
 * @param pattern - A regular expression, in ripgrep syntax when ripgrep is present.
 * @param glob - Optional file filter, e.g. `*.ts`.
 */
export function grep(root: string, pattern: string, glob?: string): SearchMatch[] {
  return hasRipgrep() ? grepWithRipgrep(root, pattern, glob) : grepWithNode(root, pattern, glob);
}

function grepWithRipgrep(root: string, pattern: string, glob?: string): SearchMatch[] {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    "10",
    "--max-filesize",
    "1M",
    ...(glob ? ["--glob", glob] : []),
    "--",
    pattern,
    ".",
  ];
  let output: string;
  try {
    output = execFileSync("rg", args, {
      cwd: root,
      encoding: "utf8",
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // rg exits 1 when there are simply no matches, which is not an error condition.
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    return [];
  }

  const matches: SearchMatch[] = [];
  for (const raw of output.split("\n")) {
    if (matches.length >= MAX_MATCHES) break;
    const parsed = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (!parsed) continue;
    const [, file, line, text] = parsed;
    if (!file || !line) continue;
    matches.push({
      file: file
        .replace(/^\.[\\/]/, "")
        .split(sep)
        .join("/"),
      line: Number(line),
      text: truncate(text ?? ""),
    });
  }
  return matches;
}

/** Portable fallback. Uses git's own file list so ignore rules are respected. */
function grepWithNode(root: string, pattern: string, glob?: string): SearchMatch[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return [];
  }
  const matches: SearchMatch[] = [];
  for (const file of listFiles(root, glob)) {
    if (matches.length >= MAX_MATCHES) break;
    const resolved = resolveInsideRoot(root, file);
    if (resolved === null) continue;
    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch {
      continue;
    }
    // Binary files decode to U+FFFD replacement characters when read as utf8.
    if (content.includes("\uFFFD")) continue;
    const lines = content.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 10 && matches.length < MAX_MATCHES; i += 1) {
      const line = lines[i];
      if (line !== undefined && regex.test(line)) {
        matches.push({ file, line: i + 1, text: truncate(line) });
        perFile += 1;
      }
    }
  }
  return matches;
}

/**
 * List tracked files, optionally filtered by a glob.
 *
 * Uses `git ls-files`, so ignored files are excluded for free and the result matches
 * what a reviewer would consider part of the repository.
 */
export function listFiles(root: string, glob?: string): string[] {
  const output = git(root, glob ? ["ls-files", glob] : ["ls-files"]);
  if (output === null) return [];
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(0, 5000);
}

/** Read a window of a file. Returns 1-indexed numbered lines, bounded. */
export function readFileWindow(
  root: string,
  file: string,
  startLine = 1,
  endLine?: number,
): { content: string; totalLines: number } | null {
  const resolved = resolveInsideRoot(root, file);
  if (resolved === null) return null;
  let lines: string[];
  try {
    lines = readFileSync(resolved, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  const from = Math.max(1, startLine);
  const to = Math.min(
    lines.length,
    endLine ?? from + MAX_READ_LINES - 1,
    from + MAX_READ_LINES - 1,
  );
  const numbered = lines
    .slice(from - 1, to)
    .map((line, index) => `${String(from + index).padStart(5)}  ${truncate(line, 500)}`)
    .join("\n");
  return { content: numbered, totalLines: lines.length };
}

/**
 * Find commits whose diff added or removed a string.
 *
 * `git log -S` is often the fastest route to "when did this break and why", and it costs
 * nothing but a subprocess.
 */
export function searchHistory(root: string, needle: string, limit = 10): string[] {
  const output = git(root, [
    "log",
    `-S${needle}`,
    `--max-count=${limit}`,
    "--date=short",
    "--pretty=format:%h %ad %an: %s",
  ]);
  return output === null || output === "" ? [] : output.split("\n");
}

/** Files changed most recently, as a weak relevance signal. */
export function recentlyChangedFiles(root: string, limit = 20): string[] {
  const output = git(root, ["log", "--name-only", "--pretty=format:", "--max-count=25"]);
  if (output === null) return [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const file = line.trim();
    if (file.length > 0) seen.add(file);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function truncate(text: string, limit = MAX_LINE_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

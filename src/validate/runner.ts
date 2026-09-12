import { spawnSync } from "node:child_process";
import type { DiscoveredCommands, ValidationResult } from "../core/types.js";

/**
 * Deterministic validation.
 *
 * No model is involved in deciding whether the tests passed. The exit code decides, and
 * the model is told the answer rather than asked for it. This is the clearest case in the
 * whole pipeline of work that must not be delegated to an LLM: "did the suite pass" has a
 * correct answer that costs nothing to obtain.
 *
 * Commands come from {@link DiscoveredCommands}, which reads the repository's own
 * configuration. A command Forge invented would fail for reasons that teach nobody
 * anything, so an undiscovered command is skipped rather than guessed.
 */

/** Output kept per command. The full log goes to the run directory. */
const MAX_EXCERPT_CHARS = 4000;

export interface ValidationOptions {
  root: string;
  commands: DiscoveredCommands;
  /** Per-command timeout. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Which kinds to run, in order. Defaults to all discovered. */
  kinds?: Array<ValidationResult["kind"]>;
  onStart?: (kind: string, command: string) => void;
}

/**
 * Run the discovered validation commands.
 *
 * Ordered cheapest-first: a typecheck failure makes the test run irrelevant, and finding
 * out in four seconds beats finding out in four minutes.
 */
export function runValidation(options: ValidationOptions): ValidationResult[] {
  const order: Array<ValidationResult["kind"]> = options.kinds ?? [
    "typecheck",
    "lint",
    "test",
    "build",
  ];
  const results: ValidationResult[] = [];

  for (const kind of order) {
    const command = options.commands[kind];
    if (command === null || command === undefined) continue;
    options.onStart?.(kind, command);
    results.push(runOne(options.root, kind, command, options.timeoutMs ?? 600_000));
  }
  return results;
}

function runOne(
  root: string,
  kind: ValidationResult["kind"],
  command: string,
  timeoutMs: number,
): ValidationResult {
  const startedAt = Date.now();

  // Shell execution is required because discovered commands are shell strings
  // ("npm run test"). The command comes from the repository's own configuration, not
  // from a model, which is what makes that acceptable here. Nothing model-authored is
  // ever passed to this function.
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });

  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const timedOut =
    result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
  const exitCode = timedOut ? 124 : (result.status ?? 1);

  return {
    kind,
    command,
    exitCode,
    passed: exitCode === 0,
    outputExcerpt: excerpt(
      timedOut ? `Command timed out after ${timeoutMs}ms.\n${combined}` : combined,
    ),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Keep the tail rather than the head.
 *
 * Test runners put the summary and the failures at the end; truncating from the front
 * would discard exactly the part a reviewer needs.
 */
function excerpt(output: string): string {
  if (output.length <= MAX_EXCERPT_CHARS) return output;
  return `[…truncated…]\n${output.slice(-MAX_EXCERPT_CHARS)}`;
}

/** True when every result passed. Vacuously true when nothing ran. */
export function allPassed(results: ValidationResult[]): boolean {
  return results.every((result) => result.passed);
}

/** One-line summary for the terminal. */
export function formatValidation(results: ValidationResult[]): string {
  if (results.length === 0) return "no validation commands discovered";
  return results.map((r) => `${r.kind}: ${r.passed ? "pass" : `FAIL(${r.exitCode})`}`).join("  ");
}

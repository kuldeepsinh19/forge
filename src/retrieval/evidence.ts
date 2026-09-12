import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { Citation, CitationCheck, Evidence } from "../core/types.js";

/**
 * Mechanical verification of evidence citations.
 *
 * A claim that cites `src/auth.ts#L42-L67` is only worth more than a guess if that file
 * exists, has at least 67 lines, and the span is not blank. Checking that is cheap,
 * deterministic, and catches the exact failure mode that makes agents untrustworthy:
 * confident assertions about code that is not there.
 *
 * Nothing here calls a model.
 */

/** Longest span a single citation may claim. Wider spans cite nothing in particular. */
const MAX_SPAN_LINES = 400;

/** Verify one citation against the workspace. */
export function checkCitation(root: string, citation: Citation): CitationCheck {
  const fail = (reason: string): CitationCheck => ({ citation, ok: false, reason });

  if (citation.startLine < 1 || citation.endLine < 1) {
    return fail("line numbers are 1-indexed; received a value below 1");
  }
  if (citation.endLine < citation.startLine) {
    return fail(`inverted range: ${citation.startLine}-${citation.endLine}`);
  }
  if (citation.endLine - citation.startLine + 1 > MAX_SPAN_LINES) {
    return fail(
      `span of ${citation.endLine - citation.startLine + 1} lines exceeds ${MAX_SPAN_LINES}`,
    );
  }

  const resolved = resolveInsideRoot(root, citation.file);
  if (resolved === null) return fail("path escapes the repository root");
  if (!existsSync(resolved)) return fail("file does not exist");

  let lines: string[];
  try {
    lines = readFileSync(resolved, "utf8").split(/\r?\n/);
  } catch {
    return fail("file could not be read");
  }

  if (citation.endLine > lines.length) {
    return fail(`file has ${lines.length} lines; citation ends at ${citation.endLine}`);
  }
  const span = lines.slice(citation.startLine - 1, citation.endLine);
  if (span.every((line) => line.trim() === "")) {
    return fail("cited span is blank");
  }
  return { citation, ok: true };
}

/**
 * Resolve a repo-relative path, refusing anything that escapes the root.
 *
 * Model-supplied paths reach this function, so traversal is rejected rather than
 * normalized away.
 */
export function resolveInsideRoot(root: string, file: string): string | null {
  if (isAbsolute(file)) return null;
  const normalized = normalize(file);
  if (normalized.split(/[/\\]/).includes("..")) return null;
  const full = join(root, normalized);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return full.startsWith(rootWithSep) || full === root ? full : null;
}

/** Outcome of validating a full set of evidence. */
export interface EvidenceValidation {
  /** Evidence whose citations all resolve. */
  accepted: Evidence[];
  /** Evidence with at least one bad citation, and why. */
  rejected: Array<{ evidence: Evidence; failures: CitationCheck[] }>;
  /** accepted / (accepted + rejected), 0..1. */
  citationAccuracy: number;
}

/**
 * Validate every citation in a set of evidence.
 *
 * Evidence with a bad citation is rejected wholesale rather than partially accepted: a
 * claim standing on one real citation and one fabricated one is not two-thirds true, and
 * the fabricated half is the part that matters.
 */
export function validateEvidence(root: string, evidence: Evidence[]): EvidenceValidation {
  const accepted: Evidence[] = [];
  const rejected: Array<{ evidence: Evidence; failures: CitationCheck[] }> = [];

  for (const item of evidence) {
    if (item.citations.length === 0) {
      rejected.push({
        evidence: item,
        failures: [
          {
            citation: { file: "(none)", startLine: 0, endLine: 0 },
            ok: false,
            reason: "claim carries no citations",
          },
        ],
      });
      continue;
    }
    const checks = item.citations.map((citation) => checkCitation(root, citation));
    const failures = checks.filter((check) => !check.ok);
    if (failures.length === 0) accepted.push(item);
    else rejected.push({ evidence: item, failures });
  }

  const total = accepted.length + rejected.length;
  return { accepted, rejected, citationAccuracy: total === 0 ? 1 : accepted.length / total };
}

/** Read the exact text a citation points at, for rendering into a prompt. */
export function readCitedSpan(root: string, citation: Citation): string | null {
  const resolved = resolveInsideRoot(root, citation.file);
  if (resolved === null || !existsSync(resolved)) return null;
  try {
    const lines = readFileSync(resolved, "utf8").split(/\r?\n/);
    return lines.slice(citation.startLine - 1, citation.endLine).join("\n");
  } catch {
    return null;
  }
}

/** Render a citation in the conventional `path#Lstart-Lend` form. */
export function formatCitation(citation: Citation): string {
  return citation.startLine === citation.endLine
    ? `${citation.file}#L${citation.startLine}`
    : `${citation.file}#L${citation.startLine}-L${citation.endLine}`;
}

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCitation,
  formatCitation,
  readCitedSpan,
  resolveInsideRoot,
  validateEvidence,
} from "../src/retrieval/evidence.js";

/**
 * Citation checking is the mechanism that makes "evidence-backed" more than a claim,
 * so it is tested for the ways it can wrongly *accept* something, not just the happy path.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-evidence-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "auth.ts"),
    ["line one", "line two", "line three", "line four", "line five"].join("\n"),
    "utf8",
  );
  writeFileSync(join(root, "src", "blank.ts"), ["code", "", "   ", "", "more"].join("\n"), "utf8");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("checkCitation", () => {
  it("accepts a citation whose span exists and has content", () => {
    const result = checkCitation(root, { file: "src/auth.ts", startLine: 2, endLine: 4 });
    expect(result.ok).toBe(true);
  });

  it("accepts a single-line citation", () => {
    expect(checkCitation(root, { file: "src/auth.ts", startLine: 1, endLine: 1 }).ok).toBe(true);
  });

  it("rejects a file that does not exist", () => {
    const result = checkCitation(root, { file: "src/nope.ts", startLine: 1, endLine: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("rejects a range past the end of the file", () => {
    const result = checkCitation(root, { file: "src/auth.ts", startLine: 4, endLine: 99 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("5 lines");
  });

  it("rejects an inverted range", () => {
    const result = checkCitation(root, { file: "src/auth.ts", startLine: 4, endLine: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("inverted");
  });

  it("rejects zero and negative line numbers", () => {
    expect(checkCitation(root, { file: "src/auth.ts", startLine: 0, endLine: 2 }).ok).toBe(false);
    expect(checkCitation(root, { file: "src/auth.ts", startLine: -3, endLine: 2 }).ok).toBe(false);
  });

  it("rejects a span that is entirely blank", () => {
    // A citation to whitespace resolves as a file range but grounds nothing.
    const result = checkCitation(root, { file: "src/blank.ts", startLine: 2, endLine: 4 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("blank");
  });

  it("rejects an absurdly wide span that cites nothing in particular", () => {
    writeFileSync(join(root, "big.ts"), Array.from({ length: 900 }, (_, i) => `l${i}`).join("\n"));
    const result = checkCitation(root, { file: "big.ts", startLine: 1, endLine: 800 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeds");
  });

  it("rejects path traversal", () => {
    const result = checkCitation(root, {
      file: "../../../etc/passwd",
      startLine: 1,
      endLine: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("escapes");
  });

  it("rejects an absolute path", () => {
    const result = checkCitation(root, {
      file: join(root, "src", "auth.ts"),
      startLine: 1,
      endLine: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("resolveInsideRoot", () => {
  it("returns null for traversal and absolute paths", () => {
    expect(resolveInsideRoot(root, "../outside.ts")).toBeNull();
    expect(resolveInsideRoot(root, "a/../../b.ts")).toBeNull();
    expect(resolveInsideRoot(root, "/etc/passwd")).toBeNull();
  });

  it("resolves a normal relative path", () => {
    expect(resolveInsideRoot(root, "src/auth.ts")).toContain("auth.ts");
  });
});

describe("validateEvidence", () => {
  it("rejects a claim wholesale when any one of its citations is bad", () => {
    // A claim standing on one real citation and one fabricated one is not partly true.
    const result = validateEvidence(root, [
      {
        claim: "half-grounded",
        citations: [
          { file: "src/auth.ts", startLine: 1, endLine: 2 },
          { file: "src/ghost.ts", startLine: 1, endLine: 2 },
        ],
        confidence: 0.9,
      },
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.citationAccuracy).toBe(0);
  });

  it("rejects a claim with no citations at all", () => {
    const result = validateEvidence(root, [{ claim: "trust me", citations: [], confidence: 1 }]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.failures[0]?.reason).toContain("no citations");
  });

  it("reports accuracy across a mixed set", () => {
    const result = validateEvidence(root, [
      {
        claim: "good",
        citations: [{ file: "src/auth.ts", startLine: 1, endLine: 2 }],
        confidence: 1,
      },
      {
        claim: "bad",
        citations: [{ file: "src/ghost.ts", startLine: 1, endLine: 2 }],
        confidence: 1,
      },
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.citationAccuracy).toBe(0.5);
  });

  it("treats an empty evidence set as vacuously accurate", () => {
    expect(validateEvidence(root, []).citationAccuracy).toBe(1);
  });
});

describe("readCitedSpan", () => {
  it("returns exactly the cited lines", () => {
    expect(readCitedSpan(root, { file: "src/auth.ts", startLine: 2, endLine: 3 })).toBe(
      "line two\nline three",
    );
  });

  it("returns null outside the root", () => {
    expect(readCitedSpan(root, { file: "../x.ts", startLine: 1, endLine: 1 })).toBeNull();
  });
});

describe("formatCitation", () => {
  it("collapses a single-line range", () => {
    expect(formatCitation({ file: "a.ts", startLine: 7, endLine: 7 })).toBe("a.ts#L7");
  });

  it("renders a multi-line range", () => {
    expect(formatCitation({ file: "a.ts", startLine: 7, endLine: 9 })).toBe("a.ts#L7-L9");
  });
});

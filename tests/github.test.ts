import { describe, expect, it } from "vitest";
import { parseRemote, renderPullRequestBody, renderPullRequestTitle } from "../src/github/pr.js";
import type { TaskState } from "../src/core/types.js";

/**
 * Pull request delivery.
 *
 * The body is assembled from run state rather than written by a model, so these tests
 * pin down that every section traces to a field a stage produced — and that a failed
 * check cannot be quietly presented as a pass.
 */

describe("parseRemote", () => {
  it("parses HTTPS remotes", () => {
    expect(parseRemote("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses SSH remotes", () => {
    expect(parseRemote("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses ssh:// remotes", () => {
    expect(parseRemote("ssh://git@github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses HTTPS remotes carrying a username", () => {
    expect(parseRemote("https://someone@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns null for non-GitHub hosts rather than guessing", () => {
    expect(parseRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseRemote("git@bitbucket.org:owner/repo.git")).toBeNull();
    expect(parseRemote("/local/path/to/repo")).toBeNull();
    expect(parseRemote("")).toBeNull();
  });
});

const state = (overrides: Partial<TaskState> = {}): TaskState => ({
  task: {
    id: "t1",
    title: "add() subtracts instead of adding",
    body: "add(2, 3) returns -1.",
    source: "cli",
  },
  repository: {
    root: "/repo",
    baseBranch: "main",
    baseCommit: "abc123",
    profile: {
      languages: ["TypeScript"],
      packageManager: "npm",
      markers: [],
      commands: { test: "npm test", lint: null, typecheck: null, build: null },
      sourceDirs: ["src"],
      testDirs: ["tests"],
      instructions: null,
    },
  },
  status: "approved",
  validations: [
    {
      kind: "test",
      command: "npm test",
      exitCode: 0,
      passed: true,
      outputExcerpt: "ok",
      durationMs: 10,
    },
  ],
  revisionCount: 0,
  warnings: [],
  branch: "forge/fix-add-abc12345",
  investigation: {
    problemStatement: "add() uses subtraction.",
    rootCause: "The operator is '-' where it should be '+'.",
    evidence: [
      {
        claim: "add() returns a - b",
        citations: [{ file: "src/calc.ts", startLine: 1, endLine: 3 }],
        confidence: 0.99,
      },
    ],
    affectedFiles: ["src/calc.ts"],
    plan: ["Change - to +"],
    acceptanceCriteria: ["add(2, 3) returns 5"],
    assumptions: [],
    testStrategy: "Assert add(2,3) === 5",
  },
  implementation: {
    changes: [{ path: "src/calc.ts", rationale: "Use + instead of -." }],
    deviations: [],
    knownLimitations: [],
  },
  review: {
    verdict: "approve",
    criteriaResults: [
      { criterion: "add(2, 3) returns 5", pass: true, evidence: "Diff changes - to +." },
    ],
    blockingFindings: [],
    suggestions: [],
    summary: "Correct.",
  },
  ...overrides,
});

describe("renderPullRequestTitle", () => {
  it("uses the task title", () => {
    expect(renderPullRequestTitle(state())).toBe("add() subtracts instead of adding");
  });

  it("truncates a very long title", () => {
    const long = state({ task: { ...state().task, title: "x".repeat(200) } });
    expect(renderPullRequestTitle(long).length).toBeLessThanOrEqual(72);
    expect(renderPullRequestTitle(long).endsWith("...")).toBe(true);
  });
});

describe("renderPullRequestBody", () => {
  it("includes root cause, changes, validation and review", () => {
    const body = renderPullRequestBody(state(), { citationAccuracy: 1 });
    expect(body).toContain("## Root cause");
    expect(body).toContain("operator is '-'");
    expect(body).toContain("`src/calc.ts` — Use + instead of -.");
    expect(body).toContain("## Validation");
    expect(body).toContain("`npm test`");
    expect(body).toContain("## Independent review");
    expect(body).toContain("**approve**");
  });

  it("renders verified citations in file:line form", () => {
    const body = renderPullRequestBody(state(), { citationAccuracy: 1 });
    expect(body).toContain("`src/calc.ts:1-3`");
    expect(body).toContain("verified against the tree");
  });

  it("shows a failed check as a failure, never as a pass", () => {
    const failed = state({
      validations: [
        {
          kind: "test",
          command: "npm test",
          exitCode: 1,
          passed: false,
          outputExcerpt: "1 failing",
          durationMs: 10,
        },
      ],
    });
    const body = renderPullRequestBody(failed, { citationAccuracy: 1 });
    expect(body).toContain("**fail** (exit 1)");
  });

  it("marks a failing acceptance criterion", () => {
    const s = state();
    const failing = state({
      review: {
        ...s.review!,
        verdict: "request_changes",
        criteriaResults: [
          { criterion: "add(2, 3) returns 5", pass: false, evidence: "Still wrong." },
        ],
        blockingFindings: ["The operator is unchanged."],
      },
    });
    const body = renderPullRequestBody(failing, { citationAccuracy: 1 });
    expect(body).toContain("**fail**");
    expect(body).toContain("The operator is unchanged.");
  });

  it("surfaces discarded citations as a residual risk", () => {
    const body = renderPullRequestBody(state(), { citationAccuracy: 0.5 });
    expect(body).toContain("## Remaining risks");
    expect(body).toContain("50% of investigation claims were discarded");
  });

  it("reports revision cycles as a risk", () => {
    const body = renderPullRequestBody(state({ revisionCount: 2 }), { citationAccuracy: 1 });
    expect(body).toContain("2 revision cycle(s)");
  });

  it("links the issue when the task came from one", () => {
    const body = renderPullRequestBody(state(), { citationAccuracy: 1, closesIssue: 42 });
    expect(body).toContain("Closes #42");
  });

  it("omits the issue link when the task did not come from one", () => {
    expect(renderPullRequestBody(state(), { citationAccuracy: 1 })).not.toContain("Closes #");
  });

  it("says so plainly when nothing was validated", () => {
    const body = renderPullRequestBody(state({ validations: [] }), { citationAccuracy: 1 });
    expect(body).toContain("No validation commands were discoverable");
  });

  it("escapes pipes so a criterion cannot break the table", () => {
    const s = state();
    const piped = state({
      review: {
        ...s.review!,
        criteriaResults: [{ criterion: "a | b", pass: true, evidence: "x" }],
      },
    });
    expect(renderPullRequestBody(piped, { citationAccuracy: 1 })).toContain("a \\| b");
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ForgeConfig } from "../src/core/config.js";
import { run } from "../src/core/pipeline.js";
import type { Task } from "../src/core/types.js";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TelemetryContext,
} from "../src/provider/types.js";

/**
 * The pipeline end to end, against a real git repository and a scripted provider.
 *
 * This exercises the parts that matter most and are hardest to reason about: that the
 * stages run in order, that a rejected investigation stops the run, that the revision
 * loop is bounded, and that the review stage's context genuinely excludes the builder's
 * reasoning. None of it spends a token.
 */

let root: string;

const gitRaw = (args: string[]): void => {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-pipeline-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "calc.ts"),
    ["export function add(a: number, b: number): number {", "  return a - b;", "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: {} }),
    "utf8",
  );
  gitRaw(["init", "-q", "-b", "main"]);
  gitRaw(["config", "user.email", "test@example.com"]);
  gitRaw(["config", "user.name", "Test"]);
  gitRaw(["add", "-A"]);
  gitRaw(["commit", "-q", "-m", "initial"]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const TASK: Task = {
  id: "task-1",
  title: "add() subtracts instead of adding",
  body: "add(2, 3) returns -1 instead of 5.",
  source: "cli",
};

const config = (overrides: Partial<ForgeConfig> = {}): ForgeConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
  limits: { ...DEFAULT_CONFIG.limits, maxTurnsPerStage: 4, ...(overrides.limits ?? {}) },
  git: { ...DEFAULT_CONFIG.git, ...(overrides.git ?? {}) },
});

/** Records every request so tests can assert on what a stage was and was not shown. */
class StageScriptedProvider implements ModelProvider {
  readonly vendor = "scripted";
  readonly requests: Array<{ telemetry: TelemetryContext; request: CompletionRequest }> = [];
  private counts = new Map<string, number>();

  constructor(
    readonly model: string,
    private readonly reply: (
      stage: string,
      turn: number,
      callCount: number,
    ) => Partial<CompletionResult>,
  ) {}

  async complete(
    request: CompletionRequest,
    telemetry: TelemetryContext,
  ): Promise<CompletionResult> {
    this.requests.push({ telemetry, request });
    const count = (this.counts.get(telemetry.stage) ?? 0) + 1;
    this.counts.set(telemetry.stage, count);
    const step = this.reply(telemetry.stage, telemetry.turnIndex, count);
    return {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 400,
      },
      model: this.model,
      costUsd: 0.001,
      ...step,
    } as CompletionResult;
  }
}

const investigationSubmission = {
  id: "i1",
  name: "submit_investigation",
  input: {
    problem_statement: "add() uses subtraction.",
    root_cause: "The operator in add() is '-' where it should be '+'.",
    evidence: [
      {
        claim: "add() returns a - b",
        citations: [{ file: "src/calc.ts", start_line: 1, end_line: 3 }],
        confidence: 0.99,
      },
    ],
    affected_files: ["src/calc.ts"],
    plan: ["Change the operator in src/calc.ts from - to +"],
    acceptance_criteria: ["add(2, 3) returns 5"],
    assumptions: [],
    test_strategy: "Call add(2, 3) and assert it returns 5.",
  },
};

const fixCall = {
  id: "w1",
  name: "write_file",
  input: {
    path: "src/calc.ts",
    content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  },
};

const implementationSubmission = {
  id: "m1",
  name: "submit_implementation",
  input: {
    changes: [{ path: "src/calc.ts", rationale: "Use + instead of -." }],
    deviations: [],
    known_limitations: [],
  },
};

const approvingReview = {
  id: "r1",
  name: "submit_review",
  input: {
    verdict: "approve",
    criteria_results: [
      { criterion: "add(2, 3) returns 5", pass: true, evidence: "The diff changes - to +." },
    ],
    blocking_findings: [],
    suggestions: [],
    summary: "The operator is corrected.",
  },
};

/** A provider that drives a clean single-pass run to approval. */
const happyPath = (): StageScriptedProvider =>
  new StageScriptedProvider("test-model", (stage, _turn, count) => {
    if (stage === "investigate") return { toolCalls: [investigationSubmission] };
    if (stage === "implement" || stage === "revise") {
      return count === 1 ? { toolCalls: [fixCall] } : { toolCalls: [implementationSubmission] };
    }
    return { toolCalls: [approvingReview] };
  });

describe("run", () => {
  it("refuses to start when the working tree is dirty", async () => {
    writeFileSync(join(root, "stray.txt"), "uncommitted", "utf8");
    await expect(
      run({ task: TASK, root, config: config(), apiKey: "x", providerFactory: () => happyPath() }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it("refuses to start outside a git repository", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "forge-norepo-"));
    await expect(
      run({
        task: TASK,
        root: notARepo,
        config: config(),
        apiKey: "x",
        providerFactory: () => happyPath(),
      }),
    ).rejects.toThrow(/not a git repository/);
    rmSync(notARepo, { recursive: true, force: true });
  });

  it("runs the stages in order and approves a correct change", async () => {
    const provider = happyPath();
    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      providerFactory: () => provider,
    });

    expect(result.state.status).toBe("approved");
    expect(result.state.review?.verdict).toBe("approve");
    expect(readFileSync(join(root, "src", "calc.ts"), "utf8")).toContain("a + b");

    const stages = provider.requests.map((r) => r.telemetry.stage);
    expect(stages.indexOf("investigate")).toBeLessThan(stages.indexOf("implement"));
    expect(stages.indexOf("implement")).toBeLessThan(stages.indexOf("review"));
  });

  it("commits to a generated branch, never to main", async () => {
    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      providerFactory: () => happyPath(),
    });
    expect(result.state.branch).toMatch(/^forge\//);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(branch).not.toBe("main");
    expect(branch).toBe(result.state.branch);
  });

  it("stops after investigation on a dry run and writes nothing", async () => {
    const before = readFileSync(join(root, "src", "calc.ts"), "utf8");
    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      dryRun: true,
      providerFactory: () => happyPath(),
    });
    expect(result.state.implementation).toBeUndefined();
    expect(readFileSync(join(root, "src", "calc.ts"), "utf8")).toBe(before);
  });

  it("fails the run when no investigation claim survives citation checking", async () => {
    // An investigation grounded only in a file that does not exist must not proceed.
    const provider = new StageScriptedProvider("test-model", (stage) => {
      if (stage !== "investigate") return {};
      return {
        toolCalls: [
          {
            ...investigationSubmission,
            input: {
              ...investigationSubmission.input,
              evidence: [
                {
                  claim: "the bug is in a file that does not exist",
                  citations: [{ file: "src/imaginary.ts", start_line: 1, end_line: 5 }],
                  confidence: 0.99,
                },
              ],
            },
          },
        ],
      };
    });

    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      providerFactory: () => provider,
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.investigation).toBeUndefined();
    expect(result.citationAccuracy).toBe(0);
    expect(result.state.warnings.join(" ")).toMatch(/not grounded|Discarded/);
  });

  it("never shows the review stage the builder's rationale", async () => {
    // Independence is a property of the context, so it is asserted on the context.
    const provider = happyPath();
    await run({ task: TASK, root, config: config(), apiKey: "x", providerFactory: () => provider });

    const reviewPrompts = provider.requests
      .filter((r) => r.telemetry.stage === "review")
      .map((r) => JSON.stringify(r.request.messages));

    expect(reviewPrompts.length).toBeGreaterThan(0);
    for (const prompt of reviewPrompts) {
      expect(prompt).not.toContain("Use + instead of -.");
      expect(prompt).toContain("add(2, 3) returns 5"); // the criteria do reach it
      expect(prompt).toContain("diff");
    }
  });

  it("bounds the revision loop and gives up after the configured limit", async () => {
    const provider = new StageScriptedProvider("test-model", (stage, _turn, count) => {
      if (stage === "investigate") return { toolCalls: [investigationSubmission] };
      if (stage === "implement" || stage === "revise") {
        return count % 2 === 1
          ? { toolCalls: [fixCall] }
          : { toolCalls: [implementationSubmission] };
      }
      return {
        toolCalls: [
          {
            ...approvingReview,
            input: {
              ...approvingReview.input,
              verdict: "request_changes",
              criteria_results: [
                { criterion: "add(2, 3) returns 5", pass: false, evidence: "Not convinced." },
              ],
              blocking_findings: ["Still wrong."],
            },
          },
        ],
      };
    });

    const result = await run({
      task: TASK,
      root,
      config: config({
        limits: { ...DEFAULT_CONFIG.limits, maxTurnsPerStage: 4, maxRevisions: 1 },
      }),
      apiKey: "x",
      providerFactory: () => provider,
    });

    expect(result.state.status).toBe("rejected");
    // maxRevisions: 1 means one initial attempt plus one revision.
    const buildStages = provider.requests.filter(
      (r) => r.telemetry.stage === "implement" || r.telemetry.stage === "revise",
    );
    expect(buildStages.some((r) => r.telemetry.stage === "revise")).toBe(true);
    expect(result.state.revisionCount).toBe(1);
  });

  it("stops immediately when the reviewer rejects the approach", async () => {
    const provider = new StageScriptedProvider("test-model", (stage, _turn, count) => {
      if (stage === "investigate") return { toolCalls: [investigationSubmission] };
      if (stage === "implement" || stage === "revise") {
        return count === 1 ? { toolCalls: [fixCall] } : { toolCalls: [implementationSubmission] };
      }
      return {
        toolCalls: [
          {
            ...approvingReview,
            input: {
              ...approvingReview.input,
              verdict: "reject",
              blocking_findings: ["Wrong approach."],
            },
          },
        ],
      };
    });

    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      providerFactory: () => provider,
    });

    expect(result.state.status).toBe("rejected");
    expect(result.state.revisionCount).toBe(0);
  });

  it("downgrades an approval that carries blocking findings", async () => {
    const provider = new StageScriptedProvider("test-model", (stage, _turn, count) => {
      if (stage === "investigate") return { toolCalls: [investigationSubmission] };
      if (stage === "implement" || stage === "revise") {
        return count === 1 ? { toolCalls: [fixCall] } : { toolCalls: [implementationSubmission] };
      }
      return {
        toolCalls: [
          {
            ...approvingReview,
            input: { ...approvingReview.input, blocking_findings: ["This is actually broken."] },
          },
        ],
      };
    });

    const result = await run({
      task: TASK,
      root,
      config: config({
        limits: { ...DEFAULT_CONFIG.limits, maxTurnsPerStage: 4, maxRevisions: 0 },
      }),
      apiKey: "x",
      providerFactory: () => provider,
    });

    expect(result.state.review?.verdict).toBe("request_changes");
    expect(result.state.status).not.toBe("approved");
    expect(result.state.warnings.join(" ")).toContain("downgraded");
  });

  it("attributes telemetry to every stage and reports cache reuse", async () => {
    const provider = happyPath();
    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      providerFactory: () => provider,
    });

    const stages = result.telemetry.byStage.map((s) => s.stage).sort();
    expect(stages).toContain("investigate");
    expect(stages).toContain("implement");
    expect(stages).toContain("review");
    expect(result.telemetry.totalRequests).toBe(provider.requests.length);
    // The scripted provider reports 400 cached of 500 total volume per call.
    expect(result.telemetry.overallCacheHitRatio).toBeCloseTo(0.8, 5);
  });

  it("holds the system prompt byte-stable within every stage", async () => {
    const provider = happyPath();
    const result = await run({
      task: TASK,
      root,
      config: config(),
      apiKey: "x",
      providerFactory: () => provider,
    });
    for (const stage of result.telemetry.byStage) {
      expect(stage.prefixStable).toBe(true);
    }
  });
});

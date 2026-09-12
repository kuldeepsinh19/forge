import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnthropicProvider } from "../provider/anthropic.js";
import { withRecording } from "../provider/recording.js";
import type { ModelProvider } from "../provider/types.js";
import { probeWorkspace } from "../retrieval/workspace.js";
import {
  branchNameFor,
  commitAll,
  createBranch,
  currentCommit,
  defaultBranch,
  diffWorkingTree,
  isDirty,
  isRepository,
} from "../git/workspace.js";
import { implement } from "../stages/implement.js";
import { investigate } from "../stages/investigate.js";
import { review } from "../stages/review.js";
import { TelemetryRecorder, type RunSummary } from "../telemetry/recorder.js";
import { allPassed, runValidation } from "../validate/runner.js";
import type { ForgeConfig } from "./config.js";
import type { RepositoryContext, Task, TaskState } from "./types.js";

/**
 * The pipeline.
 *
 * This is deliberately an ordinary function with ordinary control flow. No model decides
 * what runs next, because the sequence is knowable in advance and a `for` loop expresses
 * it exactly. Delegating orchestration to a model would mean paying for a large context
 * on every step of a fixed sequence, which is the single most avoidable cost in a system
 * like this.
 *
 * Models are used for three things only: understanding the problem, writing the change,
 * and judging the result. Everything else here — sequencing, validation, diffing,
 * branching, committing, citation checking — is deterministic.
 */

export interface PipelineEvent {
  type: "stage-start" | "stage-end" | "tool" | "validation" | "info" | "warning";
  message: string;
}

export interface RunOptions {
  task: Task;
  root: string;
  config: ForgeConfig;
  apiKey: string;
  /** Directory for telemetry and artifacts. Omit to keep everything in memory. */
  runDir?: string;
  /** Stop before writing anything: investigate only. */
  dryRun?: boolean;
  onEvent?: (event: PipelineEvent) => void;
  /**
   * Injected in tests; real runs construct Anthropic providers.
   *
   * Whatever this returns is wrapped for recording by the pipeline, so a custom provider
   * cannot accidentally produce an unaccounted run.
   */
  providerFactory?: (model: string) => ModelProvider;
}

export interface RunResult {
  state: TaskState;
  telemetry: RunSummary;
  /** Fraction of investigation claims whose citations resolved. */
  citationAccuracy: number;
  runDir: string | undefined;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const emit = (type: PipelineEvent["type"], message: string): void =>
    options.onEvent?.({ type, message });

  if (!isRepository(options.root)) {
    throw new Error(`${options.root} is not a git repository.`);
  }
  if (isDirty(options.root)) {
    throw new Error(
      "The working tree has uncommitted changes. Commit or stash them first: Forge needs a " +
        "clean base to produce a meaningful diff.",
    );
  }

  const taskRunId = randomUUID();
  const recorder = new TelemetryRecorder(taskRunId, options.runDir);
  const build =
    options.providerFactory ??
    ((model: string): ModelProvider => new AnthropicProvider({ apiKey: options.apiKey, model }));
  // Recording is applied at the seam, not inside each provider, so every call is
  // accounted for regardless of which provider serves it.
  const makeProvider = (model: string): ModelProvider => withRecording(build(model), recorder);

  // Probed once, then frozen: it is rendered into every prompt's cached prefix.
  emit("info", "Probing repository…");
  const profile = probeWorkspace(options.root);
  const baseCommit = currentCommit(options.root);
  const repository: RepositoryContext = {
    root: options.root,
    baseBranch: defaultBranch(options.root),
    baseCommit,
    profile,
  };

  const commands = {
    test: options.config.validation.test ?? profile.commands.test,
    lint: options.config.validation.lint ?? profile.commands.lint,
    typecheck: options.config.validation.typecheck ?? profile.commands.typecheck,
    build: options.config.validation.build ?? profile.commands.build,
  };

  const state: TaskState = {
    task: options.task,
    repository,
    status: "pending",
    validations: [],
    revisionCount: 0,
    warnings: [],
  };

  // ── Stage 1: investigate ────────────────────────────────────────────────────
  state.status = "investigating";
  emit("stage-start", "Investigating");
  const investigation = await investigate({
    provider: makeProvider(options.config.models.investigate),
    task: options.task,
    repository,
    taskRunId,
    maxTurns: options.config.limits.maxTurnsPerStage,
    onToolCall: (name) => emit("tool", name),
  });
  state.warnings.push(...investigation.warnings);
  for (const warning of investigation.warnings) emit("warning", warning);

  if (investigation.investigation === null) {
    state.status = "failed";
    return finish(state, recorder, investigation.citationAccuracy, options.runDir);
  }
  state.investigation = investigation.investigation;
  emit(
    "stage-end",
    `Investigation complete: ${investigation.investigation.evidence.length} grounded claim(s), ` +
      `${investigation.investigation.acceptanceCriteria.length} acceptance criteria`,
  );

  if (options.dryRun) {
    state.status = "approved";
    emit("info", "Dry run: stopping before any changes are written.");
    return finish(state, recorder, investigation.citationAccuracy, options.runDir);
  }

  // ── Branch ──────────────────────────────────────────────────────────────────
  const branch = branchNameFor(taskRunId, options.task.title, options.config.git.branchPrefix);
  createBranch(options.root, branch);
  state.branch = branch;
  emit("info", `Working on branch ${branch}`);

  // ── Stages 2-4, with revision cycles ────────────────────────────────────────
  const maxAttempts = options.config.limits.maxRevisions + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const revising = attempt > 0;
    state.status = revising ? "revising" : "implementing";
    state.revisionCount = attempt;
    emit("stage-start", revising ? `Revising (cycle ${attempt})` : "Implementing");

    const built = await implement({
      provider: makeProvider(options.config.models.implement),
      task: options.task,
      repository,
      investigation: state.investigation,
      taskRunId,
      maxTurns: options.config.limits.maxTurnsPerStage,
      ...(state.review ? { priorReview: state.review } : {}),
      onToolCall: (name) => emit("tool", name),
    });
    state.warnings.push(...built.warnings);
    for (const warning of built.warnings) emit("warning", warning);

    if (built.implementation === null) {
      state.status = "failed";
      return finish(state, recorder, investigation.citationAccuracy, options.runDir);
    }
    state.implementation = built.implementation;
    emit("stage-end", `Implementation touched ${built.implementation.changes.length} file(s)`);

    // ── Validation: deterministic, no model involved ──────────────────────────
    state.status = "validating";
    emit("stage-start", "Validating");
    state.validations = runValidation({
      root: options.root,
      commands,
      timeoutMs: options.config.limits.validationTimeoutMs,
      onStart: (kind, command) => emit("validation", `${kind}: ${command}`),
    });
    for (const result of state.validations) {
      emit(
        result.passed ? "info" : "warning",
        `${result.kind} ${result.passed ? "passed" : `FAILED (exit ${result.exitCode})`}`,
      );
    }

    // ── Review: fresh context, real diff, no builder reasoning ────────────────
    state.status = "reviewing";
    emit("stage-start", "Reviewing");
    const diff = diffWorkingTree(options.root, baseCommit);
    const reviewed = await review({
      provider: makeProvider(options.config.models.review),
      task: options.task,
      repository,
      investigation: state.investigation,
      diff,
      validations: state.validations,
      taskRunId,
      maxTurns: options.config.limits.maxTurnsPerStage,
      onToolCall: (name) => emit("tool", name),
    });
    state.warnings.push(...reviewed.warnings);
    for (const warning of reviewed.warnings) emit("warning", warning);

    if (reviewed.review === null) {
      state.status = "failed";
      return finish(state, recorder, investigation.citationAccuracy, options.runDir);
    }
    state.review = reviewed.review;
    const passedCount = reviewed.review.criteriaResults.filter((c) => c.pass).length;
    emit(
      "stage-end",
      `Review: ${reviewed.review.verdict} (${passedCount}/${reviewed.review.criteriaResults.length} criteria passed)`,
    );

    if (reviewed.review.verdict === "reject") {
      state.status = "rejected";
      emit("warning", "Reviewer rejected the approach; stopping without further cycles.");
      break;
    }

    if (reviewed.review.verdict === "approve" && allPassed(state.validations)) {
      state.status = "approved";
      if (options.config.git.autoCommit) {
        const sha = commitAll(options.root, commitMessage(state));
        emit("info", sha ? `Committed ${sha.slice(0, 12)}` : "Nothing to commit.");
      }
      break;
    }

    // Approved but validation failed: that is a review miss, not a pass.
    if (reviewed.review.verdict === "approve") {
      emit("warning", "Reviewer approved but validation failed; treating as request_changes.");
    }

    if (attempt === maxAttempts - 1) {
      state.status = "rejected";
      emit("warning", `Revision limit (${options.config.limits.maxRevisions}) reached.`);
    }
  }

  return finish(state, recorder, investigation.citationAccuracy, options.runDir);
}

function finish(
  state: TaskState,
  recorder: TelemetryRecorder,
  citationAccuracy: number,
  runDir: string | undefined,
): RunResult {
  if (runDir) {
    mkdirSync(runDir, { recursive: true });
    recorder.writeSummary(runDir);
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  }
  return { state, telemetry: recorder.summarize(), citationAccuracy, runDir };
}

/** Commit message built from the pipeline's own outputs, never from free-form model text. */
function commitMessage(state: TaskState): string {
  const lines = [state.task.title, ""];
  if (state.investigation) {
    lines.push(state.investigation.problemStatement, "");
  }
  if (state.implementation) {
    for (const change of state.implementation.changes) {
      lines.push(`- ${change.path}: ${change.rationale}`);
    }
  }
  const passed = state.validations.filter((v) => v.passed).length;
  if (state.validations.length > 0) {
    lines.push("", `Validation: ${passed}/${state.validations.length} checks passed.`);
  }
  return lines.join("\n");
}

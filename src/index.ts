/**
 * Forge — context-efficient AI agents for software engineering.
 *
 * The public API is intentionally small. Everything exported here is supported; anything
 * reachable by a deeper import path is internal and may change without a major version.
 *
 * The usual entry point is {@link run}, which takes a task and a repository and returns
 * the resulting state plus exact token accounting.
 */

export { run } from "./core/pipeline.js";
export type { PipelineEvent, RunOptions, RunResult } from "./core/pipeline.js";

export { loadConfig, DEFAULT_CONFIG, configSchema, CONFIG_FILENAME } from "./core/config.js";
export type { ForgeConfig } from "./core/config.js";

export type {
  Citation,
  CitationCheck,
  Evidence,
  FileChange,
  Implementation,
  Investigation,
  RepositoryContext,
  Review,
  RunStatus,
  Stage,
  Task,
  TaskState,
  ValidationResult,
  WorkspaceProfile,
} from "./core/types.js";

/** Deterministic repository inspection. Useful on its own, and calls no model. */
export { probeWorkspace, discoverCommands } from "./retrieval/workspace.js";

/** Citation checking. The mechanism that makes "evidence-backed" mean something. */
export {
  checkCitation,
  validateEvidence,
  formatCitation,
  readCitedSpan,
} from "./retrieval/evidence.js";
export type { EvidenceValidation } from "./retrieval/evidence.js";

/** Pull request delivery. Deterministic: the body is built from run state. */
export {
  createPullRequest,
  fetchIssue,
  parseRemote,
  renderPullRequestBody,
  renderPullRequestTitle,
  resolveRepoSlug,
  resolveToken,
  PullRequestError,
} from "./github/pr.js";
export type { PullRequest, RepoSlug } from "./github/pr.js";

/** Deterministic validation. */
export { runValidation, allPassed, formatValidation } from "./validate/runner.js";

/** Cost accounting. Exported so callers can re-price stored telemetry offline. */
export {
  computeCost,
  contextVolume,
  cacheHitRatio,
  priceFor,
  PRICE_TABLE,
} from "./telemetry/cost.js";
export type { ModelPrice, PriceTable } from "./telemetry/cost.js";
export { TelemetryRecorder, formatSummary } from "./telemetry/recorder.js";
export {
  compactHistory,
  estimateMessageTokens,
  DEFAULT_HISTORY_BUDGET_TOKENS,
} from "./stages/agent-loop.js";
export type { RunSummary, StageSummary } from "./telemetry/recorder.js";

/** The provider seam. Implement this to add a vendor. */
export type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TelemetryContext,
  Usage,
} from "./provider/types.js";
export { AnthropicProvider } from "./provider/anthropic.js";
export { RecordingProvider, withRecording } from "./provider/recording.js";

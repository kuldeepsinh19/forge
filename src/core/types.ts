/**
 * The typed state a task carries through the pipeline, and the contracts each stage
 * reads and writes.
 *
 * Two rules govern everything here:
 *
 * 1. **Stages communicate through typed state, never through transcripts.** A stage
 *    receives a projection of {@link TaskState} containing only the fields it needs
 *    (see `contextFor` in `./context.js`). It never sees another stage's conversation.
 *
 * 2. **Conclusions carry citations.** An {@link Evidence} entry names a file and a line
 *    range that must exist in the workspace. Citations are checked mechanically, so a
 *    claim grounded in a file that does not exist fails rather than persuades.
 */

/** A citation into the repository. Verified against the workspace before it is trusted. */
export interface Citation {
  /** Repository-relative POSIX path, e.g. `src/booking/createSlot.ts`. */
  file: string;
  /** 1-indexed inclusive start line. */
  startLine: number;
  /** 1-indexed inclusive end line. Must be >= startLine. */
  endLine: number;
}

/** A claim about the repository, grounded in citations. */
export interface Evidence {
  /** A single specific claim. Not a summary, not a plan: one assertion. */
  claim: string;
  /** Where in the repository the claim is grounded. Never empty. */
  citations: Citation[];
  /** The model's own confidence, 0..1. Recorded, never used as a gate on its own. */
  confidence: number;
}

/** Result of checking a citation against the real workspace. */
export interface CitationCheck {
  citation: Citation;
  ok: boolean;
  /** Why it failed: missing file, range beyond EOF, empty span, inverted range. */
  reason?: string;
}

/** How the task arrived. The engine is source-agnostic; adapters normalize into this. */
export interface Task {
  /** Stable id for telemetry and branch naming. */
  id: string;
  /** One-line statement of what needs to happen. */
  title: string;
  /** The full problem statement, verbatim from the source. Never paraphrased. */
  body: string;
  /** Where it came from, for provenance only. */
  source: "cli" | "github-issue" | "file";
  /** Source-specific reference, e.g. an issue number. */
  sourceRef?: string;
}

/** The repository Forge is working in. */
export interface RepositoryContext {
  /** Absolute path to the working tree. */
  root: string;
  /** Branch the work is based on. */
  baseBranch: string;
  /** Commit the work is based on. */
  baseCommit: string;
  /** Detected once, cheaply, and then frozen. See `retrieval/workspace.ts`. */
  profile: WorkspaceProfile;
}

/**
 * A cheap, deterministic description of the repository, probed once per run and then
 * immutable.
 *
 * Frozen deliberately: it is rendered into the stable prefix of every prompt, so it must
 * produce identical bytes on every turn or prompt caching cannot hit.
 */
export interface WorkspaceProfile {
  /** Languages detected from file extensions, most common first. */
  languages: string[];
  /** Package manager inferred from lockfiles, if any. */
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "uv" | "cargo" | "go" | null;
  /** Project marker files found at the root, e.g. `package.json`, `pyproject.toml`. */
  markers: string[];
  /** Commands discovered from the repo's own config, not guessed. */
  commands: DiscoveredCommands;
  /** Directories that look like source and test roots. */
  sourceDirs: string[];
  testDirs: string[];
  /** Repository-authored agent instructions (AGENTS.md / CLAUDE.md), truncated. */
  instructions: string | null;
}

/** Validation commands discovered from the repository's own configuration. */
export interface DiscoveredCommands {
  test: string | null;
  lint: string | null;
  typecheck: string | null;
  build: string | null;
}

/** What the Investigator concluded. The contract the Builder implements against. */
export interface Investigation {
  /** The problem restated precisely, as an engineering problem. */
  problemStatement: string;
  /** The root cause, grounded in evidence. */
  rootCause: string;
  /** Evidence for the root cause. Every entry is citation-checked before acceptance. */
  evidence: Evidence[];
  /** Files the change is expected to touch. */
  affectedFiles: string[];
  /** Ordered, concrete steps. Each independently verifiable. */
  plan: string[];
  /**
   * Objective, testable criteria. The Verifier judges each one individually and
   * cannot substitute its own bar.
   */
  acceptanceCriteria: string[];
  /** What the plan assumes but could not confirm from the repository. */
  assumptions: string[];
  /** How the change should be tested, grounded in the repo's real test setup. */
  testStrategy: string;
}

/** One file the Builder changed. */
export interface FileChange {
  path: string;
  /** What changed here and why. */
  rationale: string;
}

/** What the Builder produced. */
export interface Implementation {
  /** Per-file summary of the change. */
  changes: FileChange[];
  /** Departures from the plan, each with a reason. Empty when the plan held. */
  deviations: string[];
  /** Anything the Verifier should scrutinize. */
  knownLimitations: string[];
}

/** Result of one validation command. Deterministic: no model involved. */
export interface ValidationResult {
  kind: "test" | "lint" | "typecheck" | "build";
  command: string;
  exitCode: number;
  passed: boolean;
  /** Tail of combined output, bounded. Full output goes to the run directory. */
  outputExcerpt: string;
  durationMs: number;
}

/** The Verifier's judgement of one acceptance criterion. */
export interface CriterionResult {
  criterion: string;
  pass: boolean;
  /** What in the diff or validation output shows it passing or failing. */
  evidence: string;
}

/** What the Verifier concluded. Its verdict routes the pipeline. */
export interface Review {
  verdict: "approve" | "request_changes" | "reject";
  /** One entry per acceptance criterion, judged individually. */
  criteriaResults: CriterionResult[];
  /** Problems that block shipping. Each names where, what, and why it matters. */
  blockingFindings: string[];
  /** Advisory notes that do not block. */
  suggestions: string[];
  summary: string;
}

/** Terminal state of a run. */
export type RunStatus =
  | "pending"
  | "investigating"
  | "implementing"
  | "validating"
  | "reviewing"
  | "revising"
  | "approved"
  | "rejected"
  | "failed";

/**
 * The complete state of one task moving through the pipeline.
 *
 * Every field is optional until the stage that produces it has run. Stages read a
 * narrow projection of this, never the whole object.
 */
export interface TaskState {
  task: Task;
  repository: RepositoryContext;
  status: RunStatus;
  investigation?: Investigation;
  implementation?: Implementation;
  validations: ValidationResult[];
  review?: Review;
  /** Branch the work was committed to, once the Builder has committed. */
  branch?: string;
  /** How many revision cycles have run. Capped by config. */
  revisionCount: number;
  /** Non-fatal problems worth surfacing in the final report. */
  warnings: string[];
}

/** Which pipeline stage a model call belongs to. Required on every provider call. */
export type Stage = "investigate" | "implement" | "review" | "revise";

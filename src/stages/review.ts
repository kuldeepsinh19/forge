import { z } from "zod";
import type {
  Investigation,
  RepositoryContext,
  Review,
  Task,
  ValidationResult,
} from "../core/types.js";
import type { ModelProvider } from "../provider/types.js";
import { runAgentLoop } from "./agent-loop.js";
import { verifierSystem } from "./prompts.js";
import { readOnlyTools } from "./tools.js";

/**
 * Stage 3: independent review.
 *
 * Independence here is structural, not a request. The Verifier's context is built to
 * exclude the Builder's reasoning entirely: it receives the task, the acceptance
 * criteria, the real diff produced by git, and the validation results. It does not
 * receive the Builder's rationale, its transcript, or its self-assessment.
 *
 * It gets read-only tools so it can check claims against the tree, and it must judge
 * every acceptance criterion individually with evidence, which is what stops a review
 * from collapsing into a single agreeable paragraph.
 */

const reviewSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "reject"]),
  criteria_results: z
    .array(
      z.object({
        criterion: z.string().min(1),
        pass: z.boolean(),
        evidence: z.string().min(1),
      }),
    )
    .min(1),
  blocking_findings: z.array(z.string()),
  suggestions: z.array(z.string()),
  summary: z.string().min(1),
});

const SUBMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes", "reject"],
      description:
        "approve: ships as is. request_changes: fixable problems. reject: the approach " +
        "is wrong and iterating will not fix it.",
    },
    criteria_results: {
      type: "array",
      minItems: 1,
      description:
        "One entry per acceptance criterion, in the order given. Judge each individually.",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string", description: "The criterion, verbatim." },
          pass: { type: "boolean" },
          evidence: {
            type: "string",
            description:
              "What in the diff or the validation output decides this. Cite specifics, " +
              "not impressions.",
          },
        },
        required: ["criterion", "pass", "evidence"],
      },
    },
    blocking_findings: {
      type: "array",
      items: { type: "string" },
      description:
        "Problems that block shipping. Each names a file or section, what is wrong, and " +
        "why it matters. Empty when approving.",
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "Advisory notes that do not block shipping.",
    },
    summary: { type: "string", description: "One paragraph: the verdict and what drove it." },
  },
  required: ["verdict", "criteria_results", "blocking_findings", "suggestions", "summary"],
};

/** Diff beyond this is truncated; a diff this large is itself a review finding. */
const MAX_DIFF_CHARS = 60_000;

export interface ReviewOptions {
  provider: ModelProvider;
  task: Task;
  repository: RepositoryContext;
  investigation: Investigation;
  /** The real diff, produced by git rather than described by the Builder. */
  diff: string;
  validations: ValidationResult[];
  taskRunId: string;
  maxTurns: number;
  onToolCall?: (name: string) => void;
}

export interface ReviewResult {
  review: Review | null;
  warnings: string[];
}

export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const warnings: string[] = [];

  if (options.diff.trim() === "") {
    return {
      review: {
        verdict: "reject",
        criteriaResults: options.investigation.acceptanceCriteria.map((criterion) => ({
          criterion,
          pass: false,
          evidence: "No changes were made to the working tree.",
        })),
        blockingFindings: ["The implementation stage produced no diff."],
        suggestions: [],
        summary: "Nothing was changed, so there is nothing that could satisfy the criteria.",
      },
      warnings: ["Review skipped the model: the diff was empty."],
    };
  }

  const result = await runAgentLoop({
    provider: options.provider,
    system: verifierSystem(options.repository),
    prompt: renderReviewPrompt(options),
    tools: readOnlyTools(options.repository.root),
    stage: "review",
    taskRunId: options.taskRunId,
    maxTurns: options.maxTurns,
    maxTokens: 8000,
    schema: reviewSchema,
    submitToolName: "submit_review",
    submitToolDescription:
      "Submit your review. Call this once, after judging every acceptance criterion.",
    submitInputSchema: SUBMIT_SCHEMA,
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
  });

  if (result.output === null) {
    warnings.push(`Review did not complete: ${result.reason}.`);
    if (result.validationErrors) warnings.push(...result.validationErrors);
    return { review: null, warnings };
  }

  const output = result.output;

  // A verdict that contradicts its own findings is a review failure, not a pass.
  if (output.verdict === "approve" && output.blocking_findings.length > 0) {
    warnings.push(
      `Reviewer approved while reporting ${output.blocking_findings.length} blocking ` +
        `finding(s); downgraded to request_changes.`,
    );
    output.verdict = "request_changes";
  }

  const judged = new Set(output.criteria_results.map((c) => c.criterion));
  const unjudged = options.investigation.acceptanceCriteria.filter((c) => !judged.has(c));
  if (unjudged.length > 0) {
    warnings.push(`Reviewer did not judge ${unjudged.length} of the acceptance criteria.`);
  }

  return {
    review: {
      verdict: output.verdict,
      criteriaResults: output.criteria_results,
      blockingFindings: output.blocking_findings,
      suggestions: output.suggestions,
      summary: output.summary,
    },
    warnings,
  };
}

function renderReviewPrompt(options: ReviewOptions): string {
  const sections: string[] = [];

  sections.push(
    `# Task\n\n${options.task.title}\n\n<task-description>\n${options.task.body}\n</task-description>`,
  );
  sections.push(
    `# Acceptance criteria\n\nJudge each of these individually.\n\n${options.investigation.acceptanceCriteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n")}`,
  );

  const diff =
    options.diff.length > MAX_DIFF_CHARS
      ? `${options.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters]`
      : options.diff;
  sections.push(`# The diff\n\n\`\`\`diff\n${diff}\n\`\`\``);

  if (options.validations.length > 0) {
    const rows = options.validations
      .map(
        (v) =>
          `- **${v.kind}** \`${v.command}\` — ${v.passed ? "passed" : `FAILED (exit ${v.exitCode})`}` +
          (v.passed ? "" : `\n\n\`\`\`\n${v.outputExcerpt}\n\`\`\``),
      )
      .join("\n");
    sections.push(
      `# Validation results\n\nThese were run by the pipeline, not by the implementer.\n\n${rows}`,
    );
  } else {
    sections.push(
      `# Validation results\n\nNo validation commands were discoverable in this repository, so ` +
        `nothing was run. Weigh the absence of automated verification in your judgement.`,
    );
  }

  sections.push("Review the diff and submit your findings.");
  return sections.join("\n\n");
}

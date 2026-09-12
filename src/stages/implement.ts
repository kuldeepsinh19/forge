import { z } from "zod";
import type {
  Implementation,
  Investigation,
  RepositoryContext,
  Review,
  Task,
} from "../core/types.js";
import type { ModelProvider } from "../provider/types.js";
import { formatCitation, readCitedSpan } from "../retrieval/evidence.js";
import { runAgentLoop } from "./agent-loop.js";
import { builderSystem } from "./prompts.js";
import { readOnlyTools, writeTools } from "./tools.js";

/**
 * Stage 2: implementation.
 *
 * Executes the investigation's plan in the working tree. It receives a **projection** of
 * the state, not the whole thing: the task, the plan, the acceptance criteria, and the
 * cited spans the investigation actually relied on. It never receives the investigator's
 * transcript.
 *
 * The cited spans are worth the tokens they cost: they are the exact code the plan was
 * written against, so including them removes a round of re-reading that the Builder would
 * otherwise pay for anyway.
 */

const implementationSchema = z.object({
  changes: z.array(z.object({ path: z.string().min(1), rationale: z.string().min(1) })).min(1),
  deviations: z.array(z.string()),
  known_limitations: z.array(z.string()),
});

const SUBMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      minItems: 1,
      description: "One entry per file you changed.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path." },
          rationale: { type: "string", description: "What changed here and why." },
        },
        required: ["path", "rationale"],
      },
    },
    deviations: {
      type: "array",
      items: { type: "string" },
      description: "Departures from the plan, each with its reason. Empty if the plan held.",
    },
    known_limitations: {
      type: "array",
      items: { type: "string" },
      description: "Anything the review stage should scrutinize.",
    },
  },
  required: ["changes", "deviations", "known_limitations"],
};

export interface ImplementOptions {
  provider: ModelProvider;
  task: Task;
  repository: RepositoryContext;
  investigation: Investigation;
  taskRunId: string;
  maxTurns: number;
  /** Present on a revision run: the findings that must be addressed. */
  priorReview?: Review;
  onToolCall?: (name: string) => void;
}

export interface ImplementResult {
  implementation: Implementation | null;
  warnings: string[];
}

export async function implement(options: ImplementOptions): Promise<ImplementResult> {
  const warnings: string[] = [];
  const revising = options.priorReview !== undefined;

  const result = await runAgentLoop({
    provider: options.provider,
    // Identical bytes on a revision run as on the first run, so the cached prefix
    // survives across both. Everything that differs is in the prompt.
    system: builderSystem(options.repository),
    prompt: revising
      ? renderRevisionPrompt(options.task, options.investigation, options.priorReview!)
      : renderBuildPrompt(options.task, options.investigation, options.repository),
    tools: [...readOnlyTools(options.repository.root), ...writeTools(options.repository.root)],
    stage: revising ? "revise" : "implement",
    taskRunId: options.taskRunId,
    maxTurns: options.maxTurns,
    maxTokens: 16000,
    schema: implementationSchema,
    submitToolName: "submit_implementation",
    submitToolDescription:
      "Submit your implementation report. Call this once, after every file is written.",
    submitInputSchema: SUBMIT_SCHEMA,
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
  });

  if (result.output === null) {
    warnings.push(`Implementation did not complete: ${result.reason}.`);
    if (result.validationErrors) warnings.push(...result.validationErrors);
    return { implementation: null, warnings };
  }

  return {
    implementation: {
      changes: result.output.changes.map((c) => ({ path: c.path, rationale: c.rationale })),
      deviations: result.output.deviations,
      knownLimitations: result.output.known_limitations,
    },
    warnings,
  };
}

function renderBuildPrompt(
  task: Task,
  investigation: Investigation,
  repository: RepositoryContext,
): string {
  const sections: string[] = [];

  sections.push(`# Task\n\n${task.title}\n\n<task-description>\n${task.body}\n</task-description>`);
  sections.push(`# Problem\n\n${investigation.problemStatement}`);
  sections.push(`# Root cause\n\n${investigation.rootCause}`);

  // The exact code the plan was written against. Cheaper to include than to re-read.
  const spans: string[] = [];
  for (const item of investigation.evidence) {
    for (const citation of item.citations) {
      const text = readCitedSpan(repository.root, citation);
      if (text === null) continue;
      spans.push(`### ${formatCitation(citation)}\n\n\`\`\`\n${text}\n\`\`\``);
    }
  }
  if (spans.length > 0) {
    sections.push(`# Code the plan was written against\n\n${spans.join("\n\n")}`);
  }

  sections.push(`# Plan\n\n${numbered(investigation.plan)}`);
  sections.push(
    `# Acceptance criteria\n\nThe review stage judges each of these individually.\n\n${bulleted(investigation.acceptanceCriteria)}`,
  );
  if (investigation.assumptions.length > 0) {
    sections.push(`# Assumptions the plan rests on\n\n${bulleted(investigation.assumptions)}`);
  }
  sections.push(`# Test strategy\n\n${investigation.testStrategy}`);
  sections.push("Implement the plan, then submit your report.");

  return sections.join("\n\n");
}

/**
 * A revision run.
 *
 * Deliberately does not re-send the cited code spans: the Builder has already read those
 * files this run, and the reviewer's findings are what is new. Re-sending everything is
 * how a revision cycle ends up costing more than the original implementation.
 */
function renderRevisionPrompt(task: Task, investigation: Investigation, review: Review): string {
  const failed = review.criteriaResults.filter((c) => !c.pass);

  const sections: string[] = [];
  sections.push(
    `# Revision\n\nYour implementation was reviewed and needs changes. The task and plan are unchanged.`,
  );
  sections.push(`# Task\n\n${task.title}\n\n<task-description>\n${task.body}\n</task-description>`);
  sections.push(`# Acceptance criteria\n\n${bulleted(investigation.acceptanceCriteria)}`);

  if (review.blockingFindings.length > 0) {
    sections.push(
      `# Blocking findings\n\nEvery one of these must be addressed, or recorded as a deviation with a reason it should stand.\n\n${bulleted(review.blockingFindings)}`,
    );
  }
  if (failed.length > 0) {
    sections.push(
      `# Criteria that failed\n\n${failed.map((c) => `- **${c.criterion}**\n  Reviewer's evidence: ${c.evidence}`).join("\n")}`,
    );
  }
  sections.push(`# Reviewer's summary\n\n${review.summary}`);
  sections.push("Fix the findings in the working tree, then submit an updated report.");

  return sections.join("\n\n");
}

const numbered = (items: string[]): string =>
  items.map((item, index) => `${index + 1}. ${item}`).join("\n");
const bulleted = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");

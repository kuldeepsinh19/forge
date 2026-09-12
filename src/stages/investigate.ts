import { z } from "zod";
import type { Investigation, RepositoryContext, Task } from "../core/types.js";
import type { ModelProvider } from "../provider/types.js";
import { formatCitation, validateEvidence } from "../retrieval/evidence.js";
import { runAgentLoop } from "./agent-loop.js";
import { investigatorSystem } from "./prompts.js";
import { readOnlyTools } from "./tools.js";

/**
 * Stage 1: investigation.
 *
 * Produces a root cause grounded in citations, plus the plan and acceptance criteria the
 * later stages work from. Writes nothing.
 *
 * Evidence returned here is **citation-checked against the working tree** before the
 * stage is considered successful. Claims whose citations do not resolve are discarded
 * rather than passed downstream, because an unchecked citation is just a confident
 * sentence.
 */

const citationSchema = z.object({
  file: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
});

const evidenceSchema = z.object({
  claim: z.string().min(1),
  citations: z.array(citationSchema).min(1),
  confidence: z.number().min(0).max(1),
});

const investigationSchema = z.object({
  problem_statement: z.string().min(1),
  root_cause: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  affected_files: z.array(z.string()),
  plan: z.array(z.string()).min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
  test_strategy: z.string(),
});

const SUBMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    problem_statement: {
      type: "string",
      description: "The task restated as a precise engineering problem.",
    },
    root_cause: {
      type: "string",
      description: "Why the problem occurs, in terms of specific code.",
    },
    evidence: {
      type: "array",
      minItems: 1,
      description:
        "One entry per claim. Every claim carries at least one citation to a file and " +
        "line range you actually read. Citations are verified after you submit.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "A single specific assertion." },
          citations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "Repository-relative path." },
                start_line: { type: "number", description: "1-indexed first line." },
                end_line: { type: "number", description: "1-indexed last line, inclusive." },
              },
              required: ["file", "start_line", "end_line"],
            },
          },
          confidence: { type: "number", description: "Your confidence, 0 to 1." },
        },
        required: ["claim", "citations", "confidence"],
      },
    },
    affected_files: {
      type: "array",
      items: { type: "string" },
      description: "Files the change is expected to touch.",
    },
    plan: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "Ordered concrete steps, each independently verifiable.",
    },
    acceptance_criteria: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description:
        "Objectively checkable criteria the review stage judges verbatim. Each must be " +
        "capable of failing.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "What the plan assumes but could not confirm from the repository.",
    },
    test_strategy: {
      type: "string",
      description: "What to test and how, grounded in the repository's real test setup.",
    },
  },
  required: [
    "problem_statement",
    "root_cause",
    "evidence",
    "affected_files",
    "plan",
    "acceptance_criteria",
    "assumptions",
    "test_strategy",
  ],
};

export interface InvestigateOptions {
  provider: ModelProvider;
  task: Task;
  repository: RepositoryContext;
  taskRunId: string;
  maxTurns: number;
  onToolCall?: (name: string) => void;
}

export interface InvestigateResult {
  investigation: Investigation | null;
  /** Fraction of submitted claims whose citations all resolved, 0..1. */
  citationAccuracy: number;
  /** Human-readable notes about discarded claims and loop outcome. */
  warnings: string[];
}

export async function investigate(options: InvestigateOptions): Promise<InvestigateResult> {
  const warnings: string[] = [];

  const result = await runAgentLoop({
    provider: options.provider,
    system: investigatorSystem(options.repository),
    prompt: renderTaskPrompt(options.task),
    tools: readOnlyTools(options.repository.root),
    stage: "investigate",
    taskRunId: options.taskRunId,
    maxTurns: options.maxTurns,
    maxTokens: 8000,
    schema: investigationSchema,
    submitToolName: "submit_investigation",
    submitToolDescription:
      "Submit your final investigation. Call this exactly once, when you can support the " +
      "root cause with citations you have actually read.",
    submitInputSchema: SUBMIT_SCHEMA,
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
  });

  if (result.output === null) {
    warnings.push(`Investigation did not complete: ${result.reason}.`);
    if (result.validationErrors) warnings.push(...result.validationErrors);
    return { investigation: null, citationAccuracy: 0, warnings };
  }

  const raw = result.output;
  const evidence = raw.evidence.map((item) => ({
    claim: item.claim,
    citations: item.citations.map((c) => ({
      file: c.file,
      startLine: c.start_line,
      endLine: c.end_line,
    })),
    confidence: item.confidence,
  }));

  const validation = validateEvidence(options.repository.root, evidence);
  for (const { evidence: bad, failures } of validation.rejected) {
    const detail = failures
      .map((f) => `${formatCitation(f.citation)} (${f.reason ?? "invalid"})`)
      .join("; ");
    warnings.push(`Discarded unverifiable claim "${truncate(bad.claim)}": ${detail}`);
  }

  if (validation.accepted.length === 0) {
    warnings.push("No claim survived citation checking; the investigation is not grounded.");
    return { investigation: null, citationAccuracy: 0, warnings };
  }

  return {
    investigation: {
      problemStatement: raw.problem_statement,
      rootCause: raw.root_cause,
      evidence: validation.accepted,
      affectedFiles: raw.affected_files,
      plan: raw.plan,
      acceptanceCriteria: raw.acceptance_criteria,
      assumptions: raw.assumptions,
      testStrategy: raw.test_strategy,
    },
    citationAccuracy: validation.citationAccuracy,
    warnings,
  };
}

/** The task, verbatim. Never paraphrased: the source's own words are the requirement. */
function renderTaskPrompt(task: Task): string {
  return `# Task

${task.title}

<task-description>
${task.body}
</task-description>

Investigate this against the repository and submit your findings.`;
}

function truncate(text: string, limit = 80): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

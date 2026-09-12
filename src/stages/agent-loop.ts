import type { z } from "zod";
import type { ContentBlock, Message, ModelProvider, TelemetryContext } from "../provider/types.js";
import type { Stage } from "../core/types.js";
import { definitions, type Tool, toolMap } from "./tools.js";

/**
 * The tool-use loop every reasoning stage runs.
 *
 * Deliberately small, and deliberately the *only* loop in the system. The pipeline that
 * sequences stages is ordinary control flow in `core/pipeline.ts`; no model decides what
 * runs next. A model only decides what to do *within* a stage.
 *
 * The system prompt is passed unchanged on every turn so the cached prefix stays
 * byte-identical. Anything that varies belongs in the message list.
 */

export interface AgentLoopOptions<T> {
  provider: ModelProvider;
  /** Rendered once and re-sent verbatim. Must not vary between turns of a stage. */
  system: string;
  /** The opening user message. */
  prompt: string;
  tools: Tool[];
  stage: Stage;
  taskRunId: string;
  maxTurns: number;
  maxTokens: number;
  /** Schema the final answer must satisfy. */
  schema: z.ZodType<T>;
  /** Name of the tool the model calls to deliver its final structured answer. */
  submitToolName: string;
  submitToolDescription: string;
  submitInputSchema: Record<string, unknown>;
  /** Called with each tool name as it runs, for progress output. */
  onToolCall?: (name: string) => void;
}

export interface AgentLoopResult<T> {
  /** The validated structured answer, or null when the stage never submitted one. */
  output: T | null;
  turns: number;
  /** Why the loop ended. */
  reason: "submitted" | "max_turns" | "stopped_without_submitting" | "invalid_output";
  /** Validation errors, when the model submitted something that failed the schema. */
  validationErrors?: string[];
}

/**
 * Run a stage to completion.
 *
 * The stage ends when the model calls its submit tool with output matching the schema.
 * A submission that fails validation is returned to the model once with the specific
 * errors, because a schema violation is usually a near miss rather than a misunderstanding.
 */
export async function runAgentLoop<T>(options: AgentLoopOptions<T>): Promise<AgentLoopResult<T>> {
  const submitTool: Tool = {
    definition: {
      name: options.submitToolName,
      description: options.submitToolDescription,
      inputSchema: options.submitInputSchema,
    },
    execute: () => "",
  };
  const allTools = [...options.tools, submitTool];
  const lookup = toolMap(allTools);
  const schemas = definitions(allTools);

  const messages: Message[] = [{ role: "user", content: options.prompt }];
  let validationRetried = false;

  for (let turn = 0; turn < options.maxTurns; turn += 1) {
    const telemetry: TelemetryContext = {
      taskRunId: options.taskRunId,
      stage: options.stage,
      turnIndex: turn,
    };

    const response = await options.provider.complete(
      {
        system: options.system,
        messages,
        tools: schemas,
        maxTokens: options.maxTokens,
        cachePrefix: true,
      },
      telemetry,
    );

    if (response.toolCalls.length === 0) {
      // The model answered in prose instead of submitting. Nudge once, then give up:
      // a stage that will not use its own contract is not going to be talked into it.
      if (turn === options.maxTurns - 1) {
        return { output: null, turns: turn + 1, reason: "stopped_without_submitting" };
      }
      messages.push({ role: "assistant", content: response.text || "(no content)" });
      messages.push({
        role: "user",
        content: `Call \`${options.submitToolName}\` with your final answer. Prose replies are not recorded.`,
      });
      continue;
    }

    const assistantBlocks: ContentBlock[] = [];
    if (response.text) assistantBlocks.push({ type: "text", text: response.text });
    for (const call of response.toolCalls) {
      assistantBlocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    }
    messages.push({ role: "assistant", content: assistantBlocks });

    const submission = response.toolCalls.find((call) => call.name === options.submitToolName);
    if (submission) {
      const parsed = options.schema.safeParse(submission.input);
      if (parsed.success) {
        return { output: parsed.data, turns: turn + 1, reason: "submitted" };
      }
      const errors = parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
      if (validationRetried) {
        return {
          output: null,
          turns: turn + 1,
          reason: "invalid_output",
          validationErrors: errors,
        };
      }
      validationRetried = true;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: submission.id,
            content: `Your submission did not match the required schema:\n${errors.join("\n")}\n\nCall \`${options.submitToolName}\` again with these fixed.`,
            is_error: true,
          },
        ],
      });
      continue;
    }

    const results: ContentBlock[] = [];
    for (const call of response.toolCalls) {
      options.onToolCall?.(call.name);
      const tool = lookup.get(call.name);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: tool ? safeExecute(tool, call.input) : `Unknown tool: ${call.name}`,
        is_error: tool === undefined,
      });
    }
    messages.push({ role: "user", content: results });
  }

  return { output: null, turns: options.maxTurns, reason: "max_turns" };
}

/** A throwing tool must not kill the run; the model can often recover from the message. */
function safeExecute(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.execute(input);
  } catch (error) {
    return `Tool error: ${(error as Error).message}`;
  }
}

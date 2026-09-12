import type { Stage } from "../core/types.js";

/**
 * Identifies which part of the pipeline is making a model call.
 *
 * This is a **required** argument on every provider call, not an optional one. A stage
 * that cannot name itself cannot call the model. That constraint is what makes per-stage
 * cost attribution exact rather than reconstructed from logs afterwards.
 */
export interface TelemetryContext {
  /** Groups every call belonging to one task run. */
  taskRunId: string;
  stage: Stage;
  /** 0-indexed turn within this stage. */
  turnIndex: number;
  /** Set when this call retries a rejected response, so retries stay attributable. */
  attemptNumber?: number;
}

/** Token usage as the API reports it, kept verbatim. */
export interface Usage {
  /**
   * The **uncached remainder only**, not the whole prompt.
   *
   * Total prompt = inputTokens + cacheCreationInputTokens + cacheReadInputTokens.
   * Reporting `input + output` as "total tokens" understates real context volume by an
   * order of magnitude in a well-cached agent, and makes a badly-cached one look leaner.
   */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the cache this call. Billed above base input rate. */
  cacheCreationInputTokens: number;
  /** Tokens served from cache. Billed far below base input rate. */
  cacheReadInputTokens: number;
}

/** One recorded model call. Written before the response is consumed. */
export interface RequestRecord {
  requestId: string;
  taskRunId: string;
  stage: Stage;
  turnIndex: number;
  attemptNumber: number;
  /** The model the API actually resolved, not the one requested. */
  model: string;
  usage: Usage;
  stopReason: string | null;
  latencyMs: number;
  /** Hash of the rendered system prompt, to detect prefix instability across turns. */
  systemHash: string;
  /** Hash of the serialized tool schemas. */
  toolsHash: string;
  toolCount: number;
  /** Version of the price table used, so costs can be recomputed offline. */
  priceTableVersion: string;
  costUsd: number;
  timestamp: string;
}

/** A tool the model may call. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool invocation the model requested. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of running a tool, returned to the model. */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** A message in the conversation. */
export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** What a provider call returns. */
export interface CompletionResult {
  /** The vendor's request id, when it supplies one. Used for telemetry correlation. */
  requestId?: string;
  text: string;
  toolCalls: ToolCall[];
  stopReason: string | null;
  usage: Usage;
  model: string;
  costUsd: number;
}

/** Options for a single completion. */
export interface CompletionRequest {
  /**
   * The stable prefix. Rendered identically on every turn of a stage so the cache can
   * hit; anything variable belongs in `messages`, never here.
   */
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens: number;
  temperature?: number;
  /** Mark the system prompt and tools as cacheable. Defaults to true. */
  cachePrefix?: boolean;
}

/**
 * The seam every model call passes through.
 *
 * Kept deliberately small. Adding a provider means implementing two methods, and
 * nothing above this layer knows which vendor is answering.
 */
export interface ModelProvider {
  /** Vendor identifier, e.g. `anthropic`. */
  readonly vendor: string;
  /** The model id this instance calls. */
  readonly model: string;
  complete(request: CompletionRequest, telemetry: TelemetryContext): Promise<CompletionResult>;
}

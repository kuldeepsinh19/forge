import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  ContentBlock,
  ModelProvider,
  TelemetryContext,
  ToolCall,
  Usage,
} from "./types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Retries on 429 and 5xx. Defaults to 3. */
  maxRetries?: number;
}

/**
 * The Anthropic implementation of {@link ModelProvider}.
 *
 * This class is transport only: it translates a request, calls the API, and reports what
 * the vendor charged. Recording and pricing are applied by {@link RecordingProvider},
 * which wraps it, so a future provider cannot forget to account for its calls.
 *
 * Caching is applied to the system prompt and the tool definitions, which is where the
 * stable bytes are. Callers are responsible for keeping that prefix byte-identical
 * across the turns of a stage; the recorder reports when they have not.
 */
export class AnthropicProvider implements ModelProvider {
  readonly vendor = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 3,
    });
  }

  async complete(
    request: CompletionRequest,
    // Required by the interface. Transport does not need it: RecordingProvider is the
    // layer that attributes the call to a stage.
    _telemetry: TelemetryContext,
  ): Promise<CompletionResult> {
    const cache = request.cachePrefix !== false;

    const tools = (request.tools ?? []).map((tool, index, all) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      // Marking only the final tool caches the whole tool array as one prefix block.
      ...(cache && index === all.length - 1
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      system: [
        {
          type: "text" as const,
          text: request.system,
          ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}),
        },
      ],
      ...(tools.length > 0 ? { tools } : {}),
      messages: request.messages.map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : (message.content.map(toAnthropicBlock) as Anthropic.ContentBlockParam[]),
      })),
    });

    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const toolCalls: ToolCall[] = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    return {
      requestId: response.id,
      text,
      toolCalls,
      stopReason: response.stop_reason,
      usage,
      model: response.model,
      // Pricing is applied by RecordingProvider, which knows the price table the run is
      // pinned to. A provider reports what it used; it does not decide what that costs.
      costUsd: 0,
    };
  }
}

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
  }
}

import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/provider/anthropic.js";
import type { Message } from "../src/provider/types.js";

/**
 * Prompt-cache marking.
 *
 * These assert the shape of the request that reaches the SDK, because the cost thesis
 * depends on it and the failure is silent: a request with no breakpoint on the
 * conversation still succeeds, it just costs several times more.
 *
 * The audit that prompted this found system+tools at roughly 900 tokens — below
 * Anthropic's 1024-token minimum — so marking only the prefix produced no caching at all.
 * Marking the last block of the conversation caches the whole prefix cumulatively, which
 * clears the threshold from the second turn onward.
 */

interface CapturedRequest {
  system: Array<{ cache_control?: unknown }>;
  tools?: Array<{ cache_control?: unknown }>;
  messages: Array<{ role: string; content: unknown }>;
}

/** Build a provider whose SDK call is stubbed, and capture what it was handed. */
function providerCapturing(): { provider: AnthropicProvider; captured: CapturedRequest[] } {
  const provider = new AnthropicProvider({ apiKey: "test-key", model: "claude-sonnet-5" });
  const captured: CapturedRequest[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (provider as any).client as { messages: { create: unknown } };
  client.messages.create = vi.fn(async (request: CapturedRequest) => {
    captured.push(request);
    return {
      id: "msg_1",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  });
  return { provider, captured };
}

const telemetry = { taskRunId: "r", stage: "investigate" as const, turnIndex: 0 };

const lastBlockOf = (request: CapturedRequest): Record<string, unknown> | undefined => {
  const last = request.messages[request.messages.length - 1];
  const content = last?.content;
  if (!Array.isArray(content)) return undefined;
  return content[content.length - 1] as Record<string, unknown>;
};

describe("prompt cache breakpoints", () => {
  it("marks the system prompt", async () => {
    const { provider, captured } = providerCapturing();
    await provider.complete(
      { system: "SYS", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      telemetry,
    );
    expect(captured[0]?.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the last block of the conversation, so history is cached too", async () => {
    // This is the fix. Without it the growing tool-result history is re-billed in full
    // on every turn, which is where the cost of a multi-turn stage actually lives.
    const { provider, captured } = providerCapturing();
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
    ];
    await provider.complete({ system: "SYS", messages, maxTokens: 100 }, telemetry);
    expect(lastBlockOf(captured[0]!)?.["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("promotes a string message to a block so it can carry the breakpoint", async () => {
    const { provider, captured } = providerCapturing();
    await provider.complete(
      { system: "SYS", messages: [{ role: "user", content: "plain string" }], maxTokens: 100 },
      telemetry,
    );
    const content = captured[0]?.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(lastBlockOf(captured[0]!)?.["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("marks only one block in the conversation, not every block", async () => {
    // Anthropic allows at most four breakpoints; spending them per block would waste them.
    const { provider, captured } = providerCapturing();
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a" },
          { type: "text", text: "b" },
        ],
      },
    ];
    await provider.complete({ system: "SYS", messages, maxTokens: 100 }, telemetry);
    const marked = captured[0]!.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<Record<string, unknown>>).filter((b) => b["cache_control"])
        : [],
    );
    expect(marked).toHaveLength(1);
  });

  it("marks the tool array once so the schemas sit inside the cached prefix", async () => {
    const { provider, captured } = providerCapturing();
    await provider.complete(
      {
        system: "SYS",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
        tools: [
          { name: "a", description: "a", inputSchema: { type: "object" } },
          { name: "b", description: "b", inputSchema: { type: "object" } },
        ],
      },
      telemetry,
    );
    const tools = captured[0]?.tools ?? [];
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
    expect(tools[tools.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds no breakpoints when caching is disabled", async () => {
    const { provider, captured } = providerCapturing();
    await provider.complete(
      {
        system: "SYS",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
        cachePrefix: false,
      },
      telemetry,
    );
    expect(captured[0]?.system[0]?.cache_control).toBeUndefined();
    expect(lastBlockOf(captured[0]!)?.["cache_control"]).toBeUndefined();
  });

  it("reports usage verbatim and leaves pricing to the recording wrapper", async () => {
    const { provider } = providerCapturing();
    const result = await provider.complete(
      { system: "SYS", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      telemetry,
    );
    expect(result.usage.inputTokens).toBe(10);
    expect(result.requestId).toBe("msg_1");
    expect(result.costUsd).toBe(0);
  });
});

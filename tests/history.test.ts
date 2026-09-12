import { describe, expect, it } from "vitest";
import {
  compactHistory,
  DEFAULT_HISTORY_BUDGET_TOKENS,
  estimateMessageTokens,
  runAgentLoop,
} from "../src/stages/agent-loop.js";
import type { Message } from "../src/provider/types.js";
import { z } from "zod";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TelemetryContext,
} from "../src/provider/types.js";

/**
 * History bounding and the spend cap.
 *
 * The behaviour that matters is not that compaction shrinks things — it is that it shrinks
 * them *without* breaking the tool_use/tool_result pairing the API requires, and that it
 * leaves the task and the recent turns alone.
 */

const bigResult = (chars: number): string => "x".repeat(chars);

function conversation(turns: number, resultChars = 4000): Message[] {
  const messages: Message[] = [{ role: "user", content: "the original task" }];
  for (let i = 0; i < turns; i += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read_file", input: { path: `f${i}.ts` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: bigResult(resultChars) }],
    });
  }
  return messages;
}

describe("estimateMessageTokens", () => {
  it("counts text, tool inputs and tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(400) },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "b".repeat(400) }],
      },
    ];
    expect(estimateMessageTokens(messages)).toBeGreaterThan(180);
  });

  it("is zero for an empty conversation", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});

describe("compactHistory", () => {
  it("does nothing when the conversation is within budget", () => {
    const messages = conversation(2, 100);
    const before = JSON.stringify(messages);
    expect(compactHistory(messages, 100_000)).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("frees tokens once the budget is exceeded", () => {
    const messages = conversation(20);
    const before = estimateMessageTokens(messages);
    const freed = compactHistory(messages, 5_000);
    expect(freed).toBeGreaterThan(0);
    expect(estimateMessageTokens(messages)).toBeLessThan(before);
  });

  it("preserves every tool_use / tool_result pair", () => {
    // Dropping a tool_result without its tool_use makes the request invalid, so
    // compaction must replace content rather than remove blocks.
    const messages = conversation(20);
    const countBlocks = (type: string): number =>
      messages
        .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
        .filter((b) => b.type === type).length;
    const usesBefore = countBlocks("tool_use");
    const resultsBefore = countBlocks("tool_result");

    compactHistory(messages, 5_000);

    expect(countBlocks("tool_use")).toBe(usesBefore);
    expect(countBlocks("tool_result")).toBe(resultsBefore);
    expect(usesBefore).toBe(resultsBefore);
  });

  it("never touches the original task message", () => {
    const messages = conversation(20);
    compactHistory(messages, 5_000);
    expect(messages[0]?.content).toBe("the original task");
  });

  it("leaves the most recent turns intact", () => {
    const messages = conversation(20);
    compactHistory(messages, 5_000);
    const last = messages[messages.length - 1];
    const block = typeof last?.content === "string" ? null : last?.content[0];
    expect(block?.type).toBe("tool_result");
    if (block?.type === "tool_result") {
      expect(block.content).not.toContain("[elided");
    }
  });

  it("elides the oldest results first", () => {
    const messages = conversation(20);
    compactHistory(messages, 5_000);
    const results = messages
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "tool_result");
    const firstElided = results.findIndex(
      (b) => b.type === "tool_result" && b.content.startsWith("[elided"),
    );
    expect(firstElided).toBeGreaterThanOrEqual(0);
    expect(firstElided).toBeLessThan(results.length / 2);
  });

  it("tells the model what happened and how to recover", () => {
    const messages = conversation(20);
    compactHistory(messages, 5_000);
    const elided = messages
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .find((b) => b.type === "tool_result" && b.content.startsWith("[elided"));
    expect(elided?.type === "tool_result" && elided.content).toContain("Re-read the file");
  });

  it("is idempotent: a second pass does not re-elide the placeholders", () => {
    const messages = conversation(20);
    compactHistory(messages, 5_000);
    const afterFirst = JSON.stringify(messages);
    compactHistory(messages, 5_000);
    expect(JSON.stringify(messages)).toBe(afterFirst);
  });

  it("exposes a sane default budget", () => {
    expect(DEFAULT_HISTORY_BUDGET_TOKENS).toBeGreaterThan(10_000);
    expect(DEFAULT_HISTORY_BUDGET_TOKENS).toBeLessThan(200_000);
  });
});

class CountingProvider implements ModelProvider {
  readonly vendor = "counting";
  readonly model = "counting-model";
  calls = 0;
  constructor(private readonly reply: (n: number) => Partial<CompletionResult>) {}
  async complete(_r: CompletionRequest, _t: TelemetryContext): Promise<CompletionResult> {
    this.calls += 1;
    return {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      model: this.model,
      costUsd: 0,
      ...this.reply(this.calls),
    } as CompletionResult;
  }
}

const schema = z.object({ answer: z.string() });
const base = (provider: ModelProvider) => ({
  provider,
  system: "SYS",
  prompt: "go",
  tools: [],
  stage: "investigate" as const,
  taskRunId: "r",
  maxTurns: 5,
  maxTokens: 100,
  schema,
  submitToolName: "submit",
  submitToolDescription: "submit",
  submitInputSchema: { type: "object", properties: { answer: { type: "string" } } },
});

describe("spend cap", () => {
  it("stops the stage before the first call when already over budget", async () => {
    const provider = new CountingProvider(() => ({}));
    const result = await runAgentLoop({
      ...base(provider),
      checkBudget: () => "Spend cap reached: $1.00 of $1.00.",
    });
    expect(result.reason).toBe("budget_exceeded");
    expect(result.budgetMessage).toContain("Spend cap reached");
    expect(provider.calls).toBe(0);
  });

  it("stops mid-stage when the cap is reached partway through", async () => {
    const provider = new CountingProvider((n) =>
      n >= 3
        ? { toolCalls: [{ id: "s", name: "submit", input: { answer: "done" } }] }
        : { toolCalls: [{ id: `e${n}`, name: "noop", input: {} }] },
    );
    let calls = 0;
    const result = await runAgentLoop({
      ...base(provider),
      tools: [
        {
          definition: { name: "noop", description: "n", inputSchema: { type: "object" } },
          execute: () => "ok",
        },
      ],
      checkBudget: () => (++calls > 2 ? "over" : null),
    });
    expect(result.reason).toBe("budget_exceeded");
    expect(provider.calls).toBe(2);
  });

  it("runs normally when no cap is configured", async () => {
    const provider = new CountingProvider(() => ({
      toolCalls: [{ id: "s", name: "submit", input: { answer: "ok" } }],
    }));
    const result = await runAgentLoop(base(provider));
    expect(result.reason).toBe("submitted");
  });
});

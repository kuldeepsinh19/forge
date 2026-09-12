import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentLoop } from "../src/stages/agent-loop.js";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TelemetryContext,
} from "../src/provider/types.js";
import type { Tool } from "../src/stages/tools.js";

/**
 * The agent loop, exercised against a scripted provider so the control flow is tested
 * without spending a token.
 *
 * The behaviours that matter are the failure ones: what happens when the model never
 * submits, submits the wrong shape, or calls a tool that throws.
 */

/** A provider that replays a fixed script and records what it was sent. */
class ScriptedProvider implements ModelProvider {
  readonly vendor = "scripted";
  readonly model = "scripted-model";
  readonly requests: CompletionRequest[] = [];
  readonly telemetry: TelemetryContext[] = [];
  private index = 0;

  constructor(private readonly script: Array<Partial<CompletionResult>>) {}

  async complete(
    request: CompletionRequest,
    telemetry: TelemetryContext,
  ): Promise<CompletionResult> {
    this.requests.push(request);
    this.telemetry.push(telemetry);
    const step = this.script[this.index] ?? {};
    this.index += 1;
    return {
      text: step.text ?? "",
      toolCalls: step.toolCalls ?? [],
      stopReason: step.stopReason ?? "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      model: this.model,
      costUsd: 0,
      ...step,
    } as CompletionResult;
  }
}

const answerSchema = z.object({ answer: z.string().min(1), score: z.number() });

const SUBMIT_INPUT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, score: { type: "number" } },
  required: ["answer", "score"],
};

const baseOptions = (provider: ModelProvider, tools: Tool[] = []) => ({
  provider,
  system: "SYSTEM PROMPT",
  prompt: "do the thing",
  tools,
  stage: "investigate" as const,
  taskRunId: "run-1",
  maxTurns: 5,
  maxTokens: 1000,
  schema: answerSchema,
  submitToolName: "submit",
  submitToolDescription: "submit the answer",
  submitInputSchema: SUBMIT_INPUT_SCHEMA,
});

describe("runAgentLoop", () => {
  it("returns the validated output when the model submits correctly", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "submit", input: { answer: "done", score: 1 } }] },
    ]);
    const result = await runAgentLoop(baseOptions(provider));
    expect(result.reason).toBe("submitted");
    expect(result.output).toEqual({ answer: "done", score: 1 });
    expect(result.turns).toBe(1);
  });

  it("sends the system prompt byte-identically on every turn", async () => {
    // A drifting prefix silently destroys prompt caching, so this is load-bearing.
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "b" } }] },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "x", score: 0 } }] },
    ]);
    const echo: Tool = {
      definition: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: (input) => String(input["value"]),
    };
    await runAgentLoop(baseOptions(provider, [echo]));
    const systems = new Set(provider.requests.map((r) => r.system));
    expect(systems.size).toBe(1);
    expect(provider.requests.length).toBe(3);
  });

  it("runs tools and feeds their results back", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "hello" } }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "ok", score: 1 } }] },
    ]);
    const echo: Tool = {
      definition: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: (input) => `echoed:${String(input["value"])}`,
    };
    const result = await runAgentLoop(baseOptions(provider, [echo]));
    expect(result.reason).toBe("submitted");
    const second = provider.requests[1];
    expect(JSON.stringify(second?.messages)).toContain("echoed:hello");
  });

  it("survives a tool that throws, returning the error to the model", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "boom", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "recovered", score: 0 } }] },
    ]);
    const boom: Tool = {
      definition: { name: "boom", description: "throws", inputSchema: { type: "object" } },
      execute: () => {
        throw new Error("kaboom");
      },
    };
    const result = await runAgentLoop(baseOptions(provider, [boom]));
    expect(result.output?.answer).toBe("recovered");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("kaboom");
  });

  it("reports an unknown tool as an error rather than crashing", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "ghost", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "ok", score: 0 } }] },
    ]);
    const result = await runAgentLoop(baseOptions(provider));
    expect(result.reason).toBe("submitted");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("Unknown tool: ghost");
  });

  it("retries once when the submission fails schema validation", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "submit", input: { answer: "", score: "not a number" } }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "fixed", score: 2 } }] },
    ]);
    const result = await runAgentLoop(baseOptions(provider));
    expect(result.reason).toBe("submitted");
    expect(result.output?.answer).toBe("fixed");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("did not match");
  });

  it("gives up after a second invalid submission", async () => {
    const bad = { toolCalls: [{ id: "x", name: "submit", input: { answer: 5 } }] };
    const provider = new ScriptedProvider([bad, bad, bad]);
    const result = await runAgentLoop(baseOptions(provider));
    expect(result.reason).toBe("invalid_output");
    expect(result.output).toBeNull();
    expect(result.validationErrors?.length).toBeGreaterThan(0);
  });

  it("stops at maxTurns when the model loops on tools forever", async () => {
    const loop = { toolCalls: [{ id: "t", name: "echo", input: {} }] };
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => loop));
    const echo: Tool = {
      definition: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: () => "ok",
    };
    const result = await runAgentLoop({ ...baseOptions(provider, [echo]), maxTurns: 3 });
    expect(result.reason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("nudges a prose-only reply toward the submit tool, then gives up", async () => {
    const provider = new ScriptedProvider([
      { text: "I think the answer is probably fine." },
      { text: "Still just talking." },
    ]);
    const result = await runAgentLoop({ ...baseOptions(provider), maxTurns: 2 });
    expect(result.reason).toBe("stopped_without_submitting");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      "Prose replies are not recorded",
    );
  });

  it("attributes every call to the right stage and increments the turn index", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "echo", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "a", score: 0 } }] },
    ]);
    const echo: Tool = {
      definition: { name: "echo", description: "e", inputSchema: { type: "object" } },
      execute: () => "ok",
    };
    await runAgentLoop(baseOptions(provider, [echo]));
    expect(provider.telemetry.map((t) => t.turnIndex)).toEqual([0, 1]);
    expect(provider.telemetry.every((t) => t.stage === "investigate")).toBe(true);
    expect(provider.telemetry.every((t) => t.taskRunId === "run-1")).toBe(true);
  });

  it("always exposes the submit tool alongside the stage's own tools", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "1", name: "submit", input: { answer: "a", score: 0 } }] },
    ]);
    const echo: Tool = {
      definition: { name: "echo", description: "e", inputSchema: { type: "object" } },
      execute: () => "ok",
    };
    await runAgentLoop(baseOptions(provider, [echo]));
    const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual(["echo", "submit"]);
  });
});

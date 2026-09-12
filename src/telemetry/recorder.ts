import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Stage } from "../core/types.js";
import type { RequestRecord } from "../provider/types.js";
import { contextVolume } from "./cost.js";

/** Aggregated figures for one stage. */
export interface StageSummary {
  stage: Stage;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + cacheCreation + cacheRead. The honest context figure. */
  contextVolume: number;
  /** cacheRead / contextVolume, 0..1. */
  cacheHitRatio: number;
  costUsd: number;
  /** True when every call in the stage rendered a byte-identical system prompt. */
  prefixStable: boolean;
}

export interface RunSummary {
  taskRunId: string;
  totalRequests: number;
  totalCostUsd: number;
  totalContextVolume: number;
  overallCacheHitRatio: number;
  byStage: StageSummary[];
  /** Models that were called but absent from the price table, so cost reads as 0. */
  unpricedModels: string[];
}

/**
 * Records one row per model call and derives per-stage summaries.
 *
 * Rows are appended as they happen rather than buffered, so a crashed run still leaves a
 * usable cost record behind.
 */
export class TelemetryRecorder {
  private readonly records: RequestRecord[] = [];
  private readonly systemHashesByStage = new Map<Stage, Set<string>>();
  private readonly jsonlPath: string | null;

  constructor(
    readonly taskRunId: string,
    /** Directory for this run's artifacts. Omit to keep telemetry in memory only. */
    runDir?: string,
  ) {
    this.jsonlPath = runDir ? join(runDir, "requests.jsonl") : null;
    if (this.jsonlPath) mkdirSync(dirname(this.jsonlPath), { recursive: true });
  }

  record(record: RequestRecord): void {
    this.records.push(record);
    let hashes = this.systemHashesByStage.get(record.stage);
    if (!hashes) {
      hashes = new Set();
      this.systemHashesByStage.set(record.stage, hashes);
    }
    hashes.add(record.systemHash);
    if (this.jsonlPath) {
      appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
    }
  }

  all(): readonly RequestRecord[] {
    return this.records;
  }

  summarize(): RunSummary {
    const stages = [...new Set(this.records.map((r) => r.stage))];
    const byStage = stages.map((stage) => this.summarizeStage(stage));
    const totalCost = this.records.reduce((sum, r) => sum + r.costUsd, 0);
    const totalVolume = this.records.reduce((sum, r) => sum + contextVolume(r.usage), 0);
    const totalCacheRead = this.records.reduce((sum, r) => sum + r.usage.cacheReadInputTokens, 0);
    const unpriced = [...new Set(this.records.filter((r) => r.costUsd === 0).map((r) => r.model))];

    return {
      taskRunId: this.taskRunId,
      totalRequests: this.records.length,
      totalCostUsd: totalCost,
      totalContextVolume: totalVolume,
      overallCacheHitRatio: totalVolume === 0 ? 0 : totalCacheRead / totalVolume,
      byStage,
      unpricedModels: unpriced,
    };
  }

  private summarizeStage(stage: Stage): StageSummary {
    const rows = this.records.filter((r) => r.stage === stage);
    const sum = (pick: (r: RequestRecord) => number): number =>
      rows.reduce((total, r) => total + pick(r), 0);
    const volume = sum((r) => contextVolume(r.usage));
    const cacheRead = sum((r) => r.usage.cacheReadInputTokens);

    return {
      stage,
      requests: rows.length,
      inputTokens: sum((r) => r.usage.inputTokens),
      outputTokens: sum((r) => r.usage.outputTokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: sum((r) => r.usage.cacheCreationInputTokens),
      contextVolume: volume,
      cacheHitRatio: volume === 0 ? 0 : cacheRead / volume,
      costUsd: sum((r) => r.costUsd),
      // More than one distinct system hash means the prefix changed mid-stage, which
      // silently destroys cache reuse. Worth surfacing rather than discovering in a bill.
      prefixStable: (this.systemHashesByStage.get(stage)?.size ?? 0) <= 1,
    };
  }

  /** Write the summary as JSON alongside the raw rows. */
  writeSummary(runDir: string): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(this.summarize(), null, 2), "utf8");
  }
}

/** Render a summary as a compact table for the terminal. */
export function formatSummary(summary: RunSummary): string {
  const lines: string[] = [];
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const usd = (n: number): string => `$${n.toFixed(4)}`;

  lines.push("");
  lines.push("  stage         reqs   ctx vol    cached    cost     prefix");
  lines.push("  ─────────────────────────────────────────────────────────");
  for (const s of summary.byStage) {
    lines.push(
      `  ${s.stage.padEnd(12)} ${String(s.requests).padStart(4)}  ` +
        `${s.contextVolume.toLocaleString().padStart(9)}  ` +
        `${pct(s.cacheHitRatio).padStart(6)}  ` +
        `${usd(s.costUsd).padStart(9)}  ` +
        `${s.prefixStable ? "stable" : "UNSTABLE"}`,
    );
  }
  lines.push("  ─────────────────────────────────────────────────────────");
  lines.push(
    `  ${"total".padEnd(12)} ${String(summary.totalRequests).padStart(4)}  ` +
      `${summary.totalContextVolume.toLocaleString().padStart(9)}  ` +
      `${pct(summary.overallCacheHitRatio).padStart(6)}  ` +
      `${usd(summary.totalCostUsd).padStart(9)}`,
  );
  if (summary.unpricedModels.length > 0) {
    lines.push("");
    lines.push(
      `  warning: no price entry for ${summary.unpricedModels.join(", ")}; ` +
        `cost for those calls reads as $0.`,
    );
  }
  return lines.join("\n");
}

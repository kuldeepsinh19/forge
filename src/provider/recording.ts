import { createHash } from "node:crypto";
import type { TelemetryRecorder } from "../telemetry/recorder.js";
import { computeCost, PRICE_TABLE } from "../telemetry/cost.js";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  TelemetryContext,
} from "./types.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * Wraps any {@link ModelProvider} so that every call it serves is recorded.
 *
 * Recording lives here rather than inside each provider on purpose. If a provider were
 * responsible for its own telemetry, the guarantee that "every model call is accounted
 * for" would hold only by convention — a new provider that forgot to record would produce
 * a run whose cost silently read as zero. Wrapping makes the guarantee structural:
 * accounting is applied to the seam, not repeated behind it.
 *
 * It also keeps providers to one job. A provider is transport; it translates a request,
 * calls a vendor, and reports what the vendor charged. Deciding what that costs and
 * writing it down is a separate concern.
 */
export class RecordingProvider implements ModelProvider {
  readonly vendor: string;
  readonly model: string;

  constructor(
    private readonly inner: ModelProvider,
    private readonly recorder: TelemetryRecorder,
  ) {
    this.vendor = inner.vendor;
    this.model = inner.model;
  }

  async complete(
    request: CompletionRequest,
    telemetry: TelemetryContext,
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    const result = await this.inner.complete(request, telemetry);

    // Price from the resolved model, which can differ from the one requested when an
    // alias is used. Trusting the request here would misprice every aliased call.
    const costUsd = computeCost(result.model, result.usage);

    this.recorder.record({
      requestId:
        result.requestId ?? `${telemetry.taskRunId}-${telemetry.stage}-${telemetry.turnIndex}`,
      taskRunId: telemetry.taskRunId,
      stage: telemetry.stage,
      turnIndex: telemetry.turnIndex,
      attemptNumber: telemetry.attemptNumber ?? 0,
      model: result.model,
      usage: result.usage,
      stopReason: result.stopReason,
      latencyMs: Date.now() - startedAt,
      // Hashing the rendered prefix is what makes prefix drift detectable. A stage that
      // produces two different hashes has quietly lost its cache.
      systemHash: sha256(request.system),
      toolsHash: sha256(JSON.stringify(request.tools ?? [])),
      toolCount: request.tools?.length ?? 0,
      priceTableVersion: PRICE_TABLE.version,
      costUsd,
      timestamp: new Date().toISOString(),
    });

    return { ...result, costUsd };
  }
}

/** Convenience wrapper. */
export function withRecording(provider: ModelProvider, recorder: TelemetryRecorder): ModelProvider {
  return new RecordingProvider(provider, recorder);
}

import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

import type { OpenBoxLogger } from "./types.js";

/**
 * Public types for `lifecycle-telemetry.ts`'s bounded, non-blocking telemetry
 * queue. Split out purely to keep that file focused on queue MECHANICS (module
 * split, no behavior change) — mirrors how Phase 3a split `lifecycle-events.ts`
 * into builders/inputs/serialization by concern.
 */

export type TelemetryOverflowPolicy = "drop-newest";

export type TelemetryDiagnosticReason =
  | "queue-overflow"
  | "run-truncated"
  | "send-failed"
  | "flush-timeout"
  | "payload-oversize-dropped";

/** Queue diagnostics — distinct from `onEvent`: drops, failures, and flush-timeout counts, never a successfully-sent payload. */
export interface TelemetryDiagnostic {
  reason: TelemetryDiagnosticReason;
  message: string;
  /** Absent only for a queue-wide diagnostic (`flush-timeout`) that isn't tied to one event. */
  runId?: string | undefined;
  eventType?: string | undefined;
}

export interface TelemetryQueueOptions {
  /** Max concurrent `client.evaluate` calls in flight across ALL runs. Default 8. */
  maxConcurrentSends?: number;
  /** Max events accepted-but-not-yet-settled across ALL runs. Default 1000. */
  maxPendingEvents?: number;
  /** Overall bound on `flush()`'s wait for in-flight/queued sends, ms. Default 30000. */
  flushTimeoutMs?: number;
  /** Only `"drop-newest"` is implemented — largest-backlog eviction was cut (RT-F8, YAGNI). */
  overflowPolicy?: TelemetryOverflowPolicy;
  /** Per-field cap applied before the whole-envelope cap. Default 8192. */
  maxFieldBytes?: number;
  /** Whole prepared-envelope cap, UTF-8 bytes. Default 262144 (256 KiB). */
  maxPayloadBytes?: number;
  /** Queue diagnostics (drops, failures, flush-timeout) — invoked defensively; a throw is caught + logged. */
  onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void;
}

export interface TelemetryQueueDeps {
  client: Pick<OpenBoxClient, "evaluate">;
  logger?: OpenBoxLogger | undefined;
}

export interface EnqueueTelemetryItem {
  runId: string;
  eventType: string;
  payload: Record<string, JsonValue>;
  /** True for a run's WorkflowCompleted/WorkflowFailed — its last emission. Drives per-run cleanup. */
  isTerminal: boolean;
  /** Fired synchronously, at most once, iff the item is accepted (never on drop/divert). Invoked defensively. */
  onAccepted?: ((payload: Record<string, JsonValue>) => void) | undefined;
}

export interface TelemetryQueueStats {
  droppedTelemetryEvents: number;
  failedTelemetrySends: number;
  inFlightSends: number;
  pendingEvents: number;
}

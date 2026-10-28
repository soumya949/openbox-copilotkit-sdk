import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

import {
  boundPreparedPayload,
  DEFAULT_MAX_FIELD_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES
} from "./lifecycle-telemetry-payload-bounds.js";
import { Semaphore } from "./lifecycle-telemetry-semaphore.js";
import type {
  EnqueueTelemetryItem,
  TelemetryDiagnosticReason,
  TelemetryQueueDeps,
  TelemetryQueueOptions,
  TelemetryQueueStats
} from "./lifecycle-telemetry-types.js";

/**
 * Bounded, non-blocking telemetry sender (fixes B4 — see the phase-03 plan's
 * "Bounded telemetry queue" section, the authoritative spec this file
 * implements). Callers `enqueue()` a prepared lifecycle payload and get
 * control back immediately; delivery happens on an internally-managed
 * per-run FIFO chain, bounded by a GLOBAL cross-run concurrency semaphore
 * (`lifecycle-telemetry-semaphore.ts`) and a GLOBAL pending-events cap so an
 * unrelated run is never serialized behind a slow/hung one and a stalled
 * Core can never grow memory unboundedly.
 *
 * This file owns queue MECHANICS only (ordering, concurrency, overflow,
 * rejection isolation, drain) — payload-size bounding lives in
 * `lifecycle-telemetry-payload-bounds.ts`; public types live in
 * `lifecycle-telemetry-types.ts` (re-exported below for a single import
 * surface).
 */

export type {
  EnqueueTelemetryItem,
  TelemetryDiagnostic,
  TelemetryDiagnosticReason,
  TelemetryOverflowPolicy,
  TelemetryQueueDeps,
  TelemetryQueueOptions,
  TelemetryQueueStats
} from "./lifecycle-telemetry-types.js";

const DEFAULT_MAX_CONCURRENT_SENDS = 8;
const DEFAULT_MAX_PENDING_EVENTS = 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms).unref?.();
  });
}

export class LifecycleTelemetryQueue {
  readonly #client: TelemetryQueueDeps["client"];
  readonly #logger: TelemetryQueueDeps["logger"];
  readonly #maxPendingEvents: number;
  readonly #maxFieldBytes: number;
  readonly #maxPayloadBytes: number;
  readonly #flushTimeoutMs: number;
  readonly #onDiagnostic: TelemetryQueueOptions["onDiagnostic"];
  readonly #semaphore: Semaphore;
  // Per-run FIFO chain tails. Self-cleaning (see #appendToChain) — bounded
  // even for a run whose telemetry never funnels through a middleware
  // Observable teardown (e.g. after-request.ts's standalone signal).
  readonly #runChains = new Map<string, Promise<void>>();
  // Runs truncated by a queue-overflow drop: every later event for them
  // diverts to onDiagnostic instead of the queue (Core must never see a
  // completion for a run whose start it never received).
  readonly #truncatedRuns = new Set<string>();

  #pendingEvents = 0;
  #inFlightSends = 0;
  #droppedTelemetryEvents = 0;
  #failedTelemetrySends = 0;

  constructor(deps: TelemetryQueueDeps, options: TelemetryQueueOptions = {}) {
    this.#client = deps.client;
    this.#logger = deps.logger;
    this.#maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
    this.#maxFieldBytes = options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.#onDiagnostic = options.onDiagnostic;
    this.#semaphore = new Semaphore(options.maxConcurrentSends ?? DEFAULT_MAX_CONCURRENT_SENDS);
  }

  /**
   * Accept, drop, or divert an item. ALWAYS synchronous and returns
   * immediately — the caller never awaits delivery. `onAccepted` (if
   * provided) fires with the exact bounded payload iff this call accepts it;
   * a dropped/diverted item only ever reaches `onDiagnostic`.
   */
  enqueue(item: EnqueueTelemetryItem): void {
    if (this.#truncatedRuns.has(item.runId)) {
      this.#divert(item, "run-truncated", "run already truncated by an earlier queue-overflow drop");
      return;
    }

    const bound = boundPreparedPayload(item.payload, {
      maxFieldBytes: this.#maxFieldBytes,
      maxPayloadBytes: this.#maxPayloadBytes
    });
    if (bound.payload === null) {
      this.#divert(
        item,
        "payload-oversize-dropped",
        `prepared envelope exceeds maxPayloadBytes (${this.#maxPayloadBytes}) even after truncating every truncatable field`
      );
      return;
    }

    if (this.#pendingEvents >= this.#maxPendingEvents) {
      this.#droppedTelemetryEvents += 1;
      this.#truncatedRuns.add(item.runId);
      this.#divert(
        item,
        "queue-overflow",
        `pending-events cap reached (${this.#maxPendingEvents}) — dropping newest and truncating the run`
      );
      return;
    }

    const accepted = bound.payload;
    this.#pendingEvents += 1;
    this.#notifyAccepted(item, accepted);
    this.#appendToChain(item.runId, () => this.#send(item, accepted));
  }

  /**
   * Defensive, idempotent cleanup of one run's TRUNCATION FLAG. Called from
   * the middleware's `source.subscribe` teardown so an early-unsubscribed or
   * hard-errored run (no telemetry terminal event ever enqueued) cannot leave
   * the flag set forever. Deliberately does NOT touch `#runChains`: that map
   * self-cleans once a run's own last item settles (`#appendToChain`)
   * regardless of "terminal" status, and forcing it here could discard the
   * bookkeeping for an EARLIER, still-in-flight send on the SAME run whose
   * LATER event was diverted/dropped (truncation can be triggered on any
   * event, not only the run's first) — `flush()` would then stop waiting for
   * that send before it actually settles.
   */
  endRun(runId: string): void {
    this.#truncatedRuns.delete(runId);
  }

  /** Bounded drain: wait for every currently in-flight/queued send, up to `timeoutMs` (default `flushTimeoutMs`). Reports the count not flushed. */
  async flush(timeoutMs?: number): Promise<{ notFlushed: number }> {
    const budget = timeoutMs ?? this.#flushTimeoutMs;
    const tails = [...this.#runChains.values()];
    if (tails.length > 0) {
      // Every chain tail resolves once settled (success or failure — errors
      // are caught per-item in #send) so Promise.all never rejects here.
      await Promise.race([Promise.all(tails), delay(budget)]);
    }
    const notFlushed = this.#pendingEvents;
    if (notFlushed > 0) {
      this.#report(
        "flush-timeout",
        `flush timed out after ${budget}ms with ${notFlushed} event(s) still pending`
      );
    }
    return { notFlushed };
  }

  /** Read-only snapshot for observability/tests. */
  stats(): TelemetryQueueStats {
    return {
      droppedTelemetryEvents: this.#droppedTelemetryEvents,
      failedTelemetrySends: this.#failedTelemetrySends,
      inFlightSends: this.#inFlightSends,
      pendingEvents: this.#pendingEvents
    };
  }

  #appendToChain(runId: string, task: () => Promise<void>): void {
    const prevTail = this.#runChains.get(runId) ?? Promise.resolve();
    const tail = prevTail.then(task);
    this.#runChains.set(runId, tail);
    // Self-cleaning: once nothing has extended this run's chain past `tail`,
    // the map entry is stale — bounds the map even for a caller that never
    // triggers an explicit terminal event or `endRun`.
    void tail.then(() => {
      if (this.#runChains.get(runId) === tail) {
        this.#runChains.delete(runId);
      }
    });
  }

  async #send(item: EnqueueTelemetryItem, payload: Record<string, JsonValue>): Promise<void> {
    await this.#semaphore.acquire();
    this.#inFlightSends += 1;
    try {
      await this.#client.evaluate(payload);
    } catch (err) {
      // Rejection isolation: caught per item, counted, never breaks the
      // chain — the next item (this run's or another's) still sends.
      this.#failedTelemetrySends += 1;
      this.#report(
        "send-failed",
        "telemetry evaluate rejected — isolated, chain continues",
        item,
        err
      );
    } finally {
      this.#inFlightSends -= 1;
      this.#pendingEvents -= 1;
      this.#semaphore.release();
      if (item.isTerminal) {
        this.endRun(item.runId);
      }
    }
  }

  #divert(item: EnqueueTelemetryItem, reason: TelemetryDiagnosticReason, message: string): void {
    this.#report(reason, message, item);
    if (item.isTerminal) {
      this.endRun(item.runId);
    }
  }

  #notifyAccepted(item: EnqueueTelemetryItem, payload: Record<string, JsonValue>): void {
    if (!item.onAccepted) {
      return;
    }
    try {
      item.onAccepted(payload);
    } catch (err) {
      this.#logger?.warn?.({
        err,
        note: "openbox telemetry queue: onAccepted observer threw — swallowed",
        run_id: item.runId
      });
    }
  }

  /** Single reporting path: logs (gated by the operator's logger) then invokes `onDiagnostic` defensively. */
  #report(
    reason: TelemetryDiagnosticReason,
    message: string,
    item?: EnqueueTelemetryItem,
    err?: unknown
  ): void {
    this.#logger?.warn?.({
      ...(err !== undefined ? { err } : {}),
      note: `openbox telemetry queue: ${message}`,
      reason,
      ...(item ? { event_type: item.eventType, run_id: item.runId } : {})
    });

    if (!this.#onDiagnostic) {
      return;
    }
    try {
      this.#onDiagnostic({
        message,
        reason,
        ...(item ? { eventType: item.eventType, runId: item.runId } : {})
      });
    } catch (diagErr) {
      this.#logger?.warn?.({
        err: diagErr,
        note: "openbox telemetry queue: onDiagnostic observer threw — swallowed"
      });
    }
  }
}

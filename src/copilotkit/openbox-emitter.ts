import {
  prepareLifecyclePayload,
  type EventEnvelope,
  type JsonValue
} from "@openbox-ai/openbox-sdk-ts";
import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { defaultPrivacyConfig, type PrivacyConfig } from "@openbox-ai/openbox-sdk-ts/config";

import type { SpanData } from "../spans/index.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { WorkflowEventType } from "../types/workflow-event-type.js";

import {
  buildActivityCompletedEnvelope,
  buildActivityStartedEnvelope,
  buildHandoffEnvelope,
  buildInterruptSignalEnvelope,
  buildSignalReceivedEnvelope,
  buildWorkflowCompletedEnvelope,
  buildWorkflowFailedEnvelope,
  buildWorkflowStartedEnvelope,
  COPILOTKIT_EVENT_SOURCE,
  COPILOTKIT_TASK_QUEUE,
  COPILOTKIT_WORKFLOW_TYPE,
  serializeOrNull,
  type ActivityCompletedInput,
  type ActivityStartedInput,
  type InterruptSignalInput,
  type SignalEmitInput,
  type WorkflowCompletedInput,
  type WorkflowFailedInput,
  type WorkflowStartedInput
} from "./lifecycle-events.js";
import { redactAndBoundRawField, redactPathsToKeySet } from "./lifecycle-redaction.js";
import type { LifecycleTelemetryQueue } from "./lifecycle-telemetry.js";
import type {
  OpenBoxEmission,
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController
} from "./types.js";

export { COPILOTKIT_TASK_QUEUE, COPILOTKIT_WORKFLOW_TYPE };

export { USER_PROMPT_SIGNAL_NAME } from "./lifecycle-events.js";

/**
 * Carrier for a synthesized `function_call` span. It is emitted as a separate
 * hook-style activity event so the original tool completion payload remains
 * small and schema-stable.
 */
export interface ActivityCompletedHookInput {
  activityArgs?: unknown;
  activityId: string;
  agentId?: string | undefined;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  span: SpanData;
  startTime?: number | undefined;
  workflowId: string;
}

/**
 * Input for `emitHandoff`. `fromAgentDid`/`multiAgentSessionId` are the ONLY
 * two fields Core requires and the only two that reach the wire (Decision
 * D1, base `handoff()` factory). Every other field here (`metadata`, `runId`,
 * `taskQueue`, `workflowId`, `workflowType`) describes the parent workflow for
 * LOCAL observability only — surfaced via `onEvent`/logs, never sent to Core.
 */
export interface HandoffEmitInput {
  fromAgentDid: string;
  metadata?: Record<string, unknown> | undefined;
  multiAgentSessionId: string;
  runId: string;
  taskQueue?: string | undefined;
  workflowId: string;
  workflowType?: string | undefined;
}

/**
 * Wraps `client.evaluate` for CopilotKit-observed AG-UI events. The six
 * lifecycle/signal methods below build a base `EventEnvelope` via
 * `lifecycle-events.ts` and run it through the base strict gate
 * (`prepareLifecyclePayload`) — no hand-built snake_case object remains for
 * those six. All six (including `emitActivityStarted`) are PURE TELEMETRY
 * (post-operation, observation only): they enqueue the prepared payload on
 * the bounded, non-blocking `LifecycleTelemetryQueue` (Phase 3, fixes B4) and
 * return immediately — `onEvent` fires with the exact payload on QUEUE
 * ACCEPTANCE, never gated on Core.
 *
 * Enforcement (Phase 4b) no longer lives here: the frontend `TOOL_CALL_END`
 * gate (`openbox-middleware.ts`) builds its OWN ActivityStarted envelope via
 * `prepareActivityStartedForEnforcement` below (redact + build + notify
 * `onEvent`, no send) and awaits the base `OpenBoxRuntime.evaluateLifecycle()`
 * directly — that is the ONE place an enforced ActivityStarted reaches Core,
 * so it must never ALSO be enqueued here (no double-send).
 *
 * `emitActivityCompletedHook` (hook-span) still hand-assembles its payload via
 * `withBaseEnvelope`/`toWireSpan` and always evaluates directly (migration
 * deferred — see that method's own note; explicitly out of scope for Phase
 * 3b). `emitHandoff` (Phase 5) builds its WIRE envelope via the base
 * `handoff()` factory (`buildHandoffEnvelope`) but keeps hand-assembling a
 * separate, richer `onEvent`-only payload via `withBaseEnvelope` — see that
 * method's own doc for why the two payloads differ. Emitter/queue failures
 * are logged and swallowed so telemetry can never break the user stream.
 */
export class OpenBoxCopilotKitEmitter {
  readonly #client: OpenBoxClient;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #onEvent: OpenBoxMiddlewareOptions["onEvent"];
  readonly #privacy: PrivacyConfig;
  readonly #redactPaths: string[] | undefined;
  readonly #telemetryQueue: LifecycleTelemetryQueue;
  readonly #controller: OpenBoxRuntimeController;

  public constructor(
    controller: OpenBoxRuntimeController,
    onEvent: OpenBoxMiddlewareOptions["onEvent"],
    redactPaths?: string[]
  ) {
    this.#client = controller.runtime.client;
    this.#logger = controller.logger;
    this.#onEvent = onEvent;
    this.#redactPaths = redactPaths;
    this.#privacy = mergeRedactPathsIntoPrivacy(controller.runtime.config.privacy, redactPaths);
    this.#telemetryQueue = controller.telemetryQueue;
    this.#controller = controller;
  }

  /**
   * Hook span(s) of an activity, sent as wire `ActivityStarted` with
   * `hook_trigger: true` on the run's telemetry queue (so they keep the
   * run's order). `spans` are flat Core span dicts.
   */
  public emitHookSpans(
    activity: { activityId: string; activityType: string; runId: string; workflowId: string },
    spans: Record<string, unknown>[]
  ): void {
    if (spans.length === 0) {
      return;
    }
    const payload = withBaseEnvelope({
      activity_id: activity.activityId,
      activity_type: activity.activityType,
      event_type: WorkflowEventType.ACTIVITY_STARTED,
      hook_trigger: true,
      run_id: activity.runId,
      span_count: spans.length,
      spans,
      workflow_id: activity.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
    });
    this.#enqueueTelemetry(
      payload as Record<string, JsonValue>,
      {
        activityId: activity.activityId,
        eventType: WorkflowEventType.ACTIVITY_STARTED,
        workflowId: activity.workflowId
      },
      activity.runId,
      false
    );
  }

  // Not `async`: pure telemetry — enqueue is synchronous and the method must
  // return without ever awaiting the actual send (B4 fix). Explicitly wraps
  // `null` in a resolved promise to keep the same `Promise<...>`-returning
  // signature every emit* method shares.
  public emitWorkflowStarted(
    input: WorkflowStartedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildWorkflowStartedEnvelope(input), {
      privacy: this.#privacy
    });

    this.#enqueueTelemetry(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_STARTED,
      workflowId: input.workflowId
    }, input.runId, false);
    return Promise.resolve(null);
  }

  public emitSignalReceived(
    input: SignalEmitInput
  ): Promise<GovernanceVerdictResponse | null> {
    const boundedInput: SignalEmitInput = {
      ...input,
      payload: this.#redactAndBound(input.payload)
    };
    const { payload } = prepareLifecyclePayload(buildSignalReceivedEnvelope(boundedInput), {
      privacy: this.#privacy
    });

    this.#enqueueTelemetry(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.SIGNAL_RECEIVED,
      workflowId: input.workflowId
    }, input.runId, false);
    return Promise.resolve(null);
  }

  /**
   * `copilotkit_interrupt` signal (fixes B3) — fired ONCE per interrupted
   * `RUN_FINISHED` in place of `WorkflowCompleted`. Pure telemetry, same
   * shape as the other non-enforcing emit* methods: enqueue on the bounded,
   * non-blocking queue (Phase 3, fixes B4) and return immediately.
   * `response_schemas` is expected to already be redacted (`run-outcome.ts`
   * does this at parse time) — this method does not redact again.
   */
  public emitInterruptSignal(
    input: InterruptSignalInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildInterruptSignalEnvelope(input), {
      privacy: this.#privacy
    });

    this.#enqueueTelemetry(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.SIGNAL_RECEIVED,
      workflowId: input.workflowId
    }, input.runId, false);
    return Promise.resolve(null);
  }

  /**
   * Pure telemetry, same shape as the other five: enqueue on the bounded,
   * non-blocking queue and return immediately. Never used for enforcement —
   * see `prepareActivityStartedForEnforcement` below for the enforce-mode
   * path (Phase 4b), which bypasses this method (and the queue) entirely.
   */
  public emitActivityStarted(
    input: ActivityStartedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const boundedInput: ActivityStartedInput = {
      ...input,
      ...(input.activityArgs !== undefined
        ? { activityArgs: this.#redactAndBound(input.activityArgs) }
        : {})
    };
    const { payload } = prepareLifecyclePayload(buildActivityStartedEnvelope(boundedInput), {
      privacy: this.#privacy
    });
    const emissionMeta = {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_STARTED,
      workflowId: input.workflowId
    };

    this.#enqueueTelemetry(payload, emissionMeta, input.runId, false);
    return Promise.resolve(null);
  }

  /**
   * Enforce-mode-only (Phase 4b, fixes B2): build + redact the ActivityStarted
   * envelope exactly like `emitActivityStarted` above, notify `onEvent` with
   * the prepared (wire-shaped) payload for observability, and return the RAW
   * `EventEnvelope` for the caller to hand to
   * `OpenBoxRuntime.evaluateLifecycle()` — which re-prepares the payload
   * internally (against the base runtime's own resolved config) before the
   * real send. This method never sends/evaluates itself and never enqueues
   * on the telemetry queue: `evaluateLifecycle` is the ONE place an enforced
   * ActivityStarted reaches Core (no double-send).
   */
  public prepareActivityStartedForEnforcement(
    input: ActivityStartedInput
  ): EventEnvelope {
    const boundedInput: ActivityStartedInput = {
      ...input,
      ...(input.activityArgs !== undefined
        ? { activityArgs: this.#redactAndBound(input.activityArgs) }
        : {})
    };
    const envelope = buildActivityStartedEnvelope(boundedInput);
    const { payload } = prepareLifecyclePayload(envelope, { privacy: this.#privacy });

    this.#notifyObserver(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_STARTED,
      workflowId: input.workflowId
    });

    return envelope;
  }

  public emitActivityCompleted(
    input: ActivityCompletedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const boundedInput: ActivityCompletedInput = {
      ...input,
      ...(input.activityArgs !== undefined
        ? { activityArgs: this.#redactAndBound(input.activityArgs) }
        : {}),
      ...(input.activityOutput !== undefined
        ? { activityOutput: this.#redactAndBound(input.activityOutput) }
        : {})
    };
    const { payload } = prepareLifecyclePayload(buildActivityCompletedEnvelope(boundedInput), {
      privacy: this.#privacy
    });

    this.#enqueueTelemetry(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_COMPLETED,
      workflowId: input.workflowId
    }, input.runId, false);
    return Promise.resolve(null);
  }

  /**
   * Sibling event to `emitActivityCompleted` that carries the synthesized
   * `function_call` span. The same `activity_id` as the original completion
   * event ties both payloads together in OpenBox.
   *
   * Phase: hook-span migration deferred — this still hand-assembles its
   * payload via `withBaseEnvelope`/`toWireSpan` rather than the base `hook()`
   * factory (base hook payload assembly owns `spans`/`span_count`, which this
   * adapter's `SpanBuffer`-derived `SpanData` shape isn't wired to yet).
   */
  public async emitActivityCompletedHook(
    input: ActivityCompletedHookInput
  ): Promise<GovernanceVerdictResponse | null> {
    const wireSpan = toWireSpan(input.span);
    const payload = withBaseEnvelope({
      activity_id: input.activityId,
      activity_input: serializeOrNull(input.activityArgs),
      activity_type: "function_call",
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      attempt: 1,
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      event_type: WorkflowEventType.ACTIVITY_STARTED,
      ...(input.goal ? { goal: input.goal } : {}),
      hook_trigger: true,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      spans: [wireSpan],
      ...(typeof input.startTime === "number"
        ? { start_time: input.startTime }
        : {}),
      workflow_id: input.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
    });

    return this.#evaluate(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_STARTED,
      workflowId: input.workflowId
    });
  }

  public async emitWorkflowCompleted(
    input: WorkflowCompletedInput
  ): Promise<GovernanceVerdictResponse | null> {
    // Core drops spans that arrive after a session closes.
    await this.#controller.openRouterProvenance?.drainRun(input.runId);
    const { payload } = prepareLifecyclePayload(buildWorkflowCompletedEnvelope(input), {
      privacy: this.#privacy
    });

    this.#enqueueTelemetry(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_COMPLETED,
      workflowId: input.workflowId
    }, input.runId, true);
    return null;
  }

  public async emitWorkflowFailed(
    input: WorkflowFailedInput
  ): Promise<GovernanceVerdictResponse | null> {
    await this.#controller.openRouterProvenance?.drainRun(input.runId);
    const { payload } = prepareLifecyclePayload(buildWorkflowFailedEnvelope(input), {
      privacy: this.#privacy
    });

    this.#enqueueTelemetry(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_FAILED,
      workflowId: input.workflowId
    }, input.runId, true);
    return null;
  }

  /**
   * Emit a multi-agent `Handoff` marker.
   *
   * Two DIFFERENT payload shapes are involved (Decision D1):
   *
   *   1. `observedPayload` — the same rich, adapter-shaped fields this method
   *      has always assembled (`child_agent_name`, `parent_activity_id`,
   *      `forwarded_context`, run/workflow ids, `task_queue`, `workflow_type`,
   *      via `input.metadata`), built with `withBaseEnvelope` exactly like
   *      before. This is surfaced to `onEvent`/logs ONLY — local
   *      observability for an operator or a remote child reading
   *      `metadata.openbox_multi_agent_context` off it (context-export mode).
   *   2. The WIRE envelope actually sent to Core when `childClient` is
   *      provided — built via `buildHandoffEnvelope` + `prepareLifecyclePayload`,
   *      i.e. the base `handoff()` factory's two required fields ONLY
   *      (`from_agent_did`+`multi_agent_session_id`). The factory has no
   *      `extra` bag, so none of the rich metadata above can ride on it.
   *      Core's `ValidateHandoffPayload` needs nothing else — it derives
   *      `to_agent` server-side from the child-signed AIP headers, never the
   *      payload.
   *
   * When `childClient` is omitted (no child credentials configured), only
   * `onEvent` fires (context-export) — nothing is sent to Core, matching the
   * pre-migration contract exactly.
   */
  public async emitHandoff(
    input: HandoffEmitInput,
    childClient?: OpenBoxClient
  ): Promise<GovernanceVerdictResponse | null> {
    // Keep invalid handoff markers off the wire (and out of onEvent).
    if (!input.fromAgentDid || !input.multiAgentSessionId) {
      this.#logger.warn?.({
        note: "openbox emitHandoff: missing from_agent_did or multi_agent_session_id — skipping handoff",
        workflow_id: input.workflowId
      });
      return null;
    }

    const observedPayload = withBaseEnvelope({
      event_type: WorkflowEventType.HANDOFF,
      from_agent_did: input.fromAgentDid,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      multi_agent_session_id: input.multiAgentSessionId,
      run_id: input.runId,
      task_queue: input.taskQueue ?? COPILOTKIT_TASK_QUEUE,
      workflow_id: input.workflowId,
      workflow_type: input.workflowType ?? COPILOTKIT_WORKFLOW_TYPE
    });
    const emissionMeta = {
      activityId: undefined,
      eventType: WorkflowEventType.HANDOFF,
      workflowId: input.workflowId
    };
    this.#notifyObserver(observedPayload, emissionMeta);

    if (!childClient) {
      return null;
    }

    const { payload } = prepareLifecyclePayload(
      buildHandoffEnvelope({
        fromAgentDid: input.fromAgentDid,
        multiAgentSessionId: input.multiAgentSessionId
      }),
      { privacy: this.#privacy }
    );

    try {
      await this.#telemetryQueue.drainRun(input.runId);
      // Signed AS THE CHILD: `childClient` is a base `OpenBoxClient` scoped to
      // the child's own DID/key (see `openbox-middleware.ts#buildChildClient`),
      // never the controller's own parent-scoped `#client`.
      const result = await childClient.evaluate(payload);
      return result as unknown as GovernanceVerdictResponse | null;
    } catch (err) {
      this.#logger.warn?.({
        err,
        event_type: payload.event_type,
        workflow_id: input.workflowId
      });
      return null;
    }
  }

  /**
   * Enqueue a prepared telemetry payload on the bounded, non-blocking queue
   * (Phase 3, fixes B4) and return immediately — the caller never awaits
   * delivery. `onAccepted` bridges the queue's "accepted for delivery"
   * signal into this emitter's own defensive `#notifyObserver`, so `onEvent`
   * fires with the exact bounded payload on queue acceptance and a
   * dropped/diverted item is never observed through it (only `onDiagnostic`,
   * owned by the queue, sees those).
   */
  #enqueueTelemetry(
    payload: Record<string, JsonValue>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">,
    runId: string,
    isTerminal: boolean
  ): void {
    this.#telemetryQueue.enqueue({
      eventType: emissionMeta.eventType,
      isTerminal,
      onAccepted: accepted => {
        this.#notifyObserver(accepted, emissionMeta);
      },
      payload,
      runId
    });
  }

  /** RT-F2(b): path-redact + size-bound a raw activity/signal field before it reaches a base event factory. */
  #redactAndBound(value: unknown): JsonValue | undefined {
    return redactAndBoundRawField(value, this.#redactPaths);
  }

  async #evaluate(
    payload: Record<string, unknown>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">
  ): Promise<GovernanceVerdictResponse | null> {
    this.#notifyObserver(payload, emissionMeta);

    try {
      await this.#telemetryQueue.drainRun(typeof payload.run_id === "string" ? payload.run_id : "");
      // The base client's `evaluate` takes a prepared `JsonValue` and
      // resolves a base `EvaluationResult`. This SDK still reads that result
      // through its own local `GovernanceVerdictResponse` shape — every field
      // it reads off the result (`verdict`, `reason`, `policyId`,
      // `governanceEventId`, `approvalId`, ...) is named identically on both
      // shapes, so this bridge is safe until a later phase unifies the two
      // types (`src/types/*` re-exports, out of this migration's scope).
      const result = await this.#client.evaluate(payload as unknown as JsonValue);
      return result as unknown as GovernanceVerdictResponse | null;
    } catch (err) {
      this.#logger.warn?.({
        err,
        event_type: payload.event_type,
        workflow_id: payload.workflow_id
      });
      return null;
    }
  }

  #notifyObserver(
    payload: Record<string, unknown>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">
  ): void {
    if (!this.#onEvent) {
      return;
    }

    try {
      this.#onEvent({
        activityId: emissionMeta.activityId,
        eventType: emissionMeta.eventType,
        payload,
        workflowId: emissionMeta.workflowId
      });
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox onEvent observer threw",
        workflow_id: emissionMeta.workflowId
      });
    }
  }

}

/**
 * RT-F2(a): translate `redactPaths` (JSONPath-like) into the leaf key-NAME
 * set the base gate's `PrivacyConfig.redactKeys` expects (deep, case-
 * insensitive key-name redaction — see `serialization/index.ts#applyRedaction`
 * in the base SDK), and merge it into whatever `redactKeys` the resolved base
 * runtime config already carries. Returns the ORIGINAL config unchanged when
 * there is nothing to add (no new object, no risk of mutating a config object
 * shared by another middleware instance on the same controller); otherwise
 * returns a NEW `PrivacyConfig` — the shared base config is never mutated.
 */
function mergeRedactPathsIntoPrivacy(
  base: PrivacyConfig | undefined,
  redactPaths: string[] | undefined
): PrivacyConfig {
  const extraKeys = redactPathsToKeySet(redactPaths);
  if (extraKeys.size === 0) {
    return base ?? defaultPrivacyConfig();
  }
  const redactKeys = new Set(base?.redactKeys ?? []);
  for (const key of extraKeys) {
    redactKeys.add(key);
  }
  return { maxBodySize: base?.maxBodySize ?? defaultPrivacyConfig().maxBodySize, redactKeys };
}

/**
 * Hand-built envelope wrapper still used by `emitActivityCompletedHook`
 * (fully unmigrated) and by `emitHandoff`'s `onEvent`-only observability
 * payload (its WIRE send is migrated — built via `buildHandoffEnvelope` +
 * `prepareLifecyclePayload`, see that method's own doc for why the two
 * differ). The six lifecycle/signal methods above build their SENT envelope
 * via `lifecycle-events.ts` and `prepareLifecyclePayload` instead.
 */
function withBaseEnvelope(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    source: COPILOTKIT_EVENT_SOURCE,
    task_queue: COPILOTKIT_TASK_QUEUE,
    timestamp: new Date().toISOString(),
    ...payload
  };
}

/**
 * Transform an internal `SpanData` into the OpenBox wire span shape.
 * Nano-time fields are sent as JS numbers for JSON transport; the internal
 * `SpanBuffer` keeps the raw `bigint` values until this boundary.
 */
function toWireSpan(span: SpanData): Record<string, unknown> {
  const startTime = Number(span.start_time_unix_nano);
  const endTime = Number(span.end_time_unix_nano);
  const attrs = { ...span.attributes } as Record<string, unknown>;
  const toolNameAttr = attrs["tool.name"];
  const toolName = typeof toolNameAttr === "string" ? toolNameAttr : undefined;

  const wire: Record<string, unknown> = {
    attributes: attrs,
    duration_ns: Math.max(0, endTime - startTime),
    end_time: endTime,
    events: [],
    ...(toolName ? { function: toolName } : {}),
    hook_type: "function_call",
    kind: "INTERNAL",
    name: span.name,
    semantic_type: "function_call",
    span_id: span.span_id,
    stage: "completed",
    start_time: startTime,
    status: {
      code: span.status === "error" ? "ERROR" : "OK"
    },
    trace_id: span.trace_id
  };

  if (span.parent_span_id) {
    wire.parent_span_id = span.parent_span_id;
  }

  return wire;
}

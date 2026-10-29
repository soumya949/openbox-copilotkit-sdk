import {
  EventType,
  Middleware,
  type AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
  type RunFinishedEvent
} from "@ag-ui/client";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  GovernanceBlockedError,
  GovernanceHaltError,
  Verdict,
  type EvaluationResult
} from "@openbox-ai/openbox-sdk-ts";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { Observable } from "rxjs";

import { attachAuditEnvelope } from "../audit/audit-envelope.js";
import { getOpenBoxExecutionContext } from "../governance/context.js";
import type { SpanData } from "../spans/index.js";
import { readSpanBufferEnv, type SpanBuffer } from "../spans/span-buffer.js";
import {
  synthesizeToolSpan,
  type ToolCallArgsEventLike
} from "../spans/tool-span-synthesizer.js";
import { OpenBoxConfigError } from "../types/errors.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";

import {
  createGovernanceBlockedErrorEvent,
  type GovernanceBlockedErrorEvent
} from "./governance-blocked-error.js";
import { CopilotKitGovernanceControlError } from "./governance-control-error.js";
import { DEFAULT_INTERRUPT_TTL_MS, type PendingInterrupt } from "./internal/interrupt-store.js";
import type { ActivityStartedInput } from "./lifecycle-events.js";
import {
  COPILOTKIT_TASK_QUEUE,
  COPILOTKIT_WORKFLOW_TYPE,
  OpenBoxCopilotKitEmitter,
  USER_PROMPT_SIGNAL_NAME
} from "./openbox-emitter.js";
import {
  parseResumeEntries,
  parseRunOutcome,
  type ParsedInterrupt,
  type ParsedResumeEntry
} from "./run-outcome.js";
import type {
  MultiAgentSessionContext,
  OpenBoxMiddlewareOptions,
  OpenBoxMultiAgentContext,
  OpenBoxMultiAgentOptions,
  OpenBoxObservedToolCall,
  OpenBoxRuntimeController,
  OpenBoxSubagentHandoffConfig
} from "./types.js";
import { CopilotKitUnsupportedVerdictError } from "./unsupported-verdict-error.js";

const TOOL_ORIGIN = "copilotkit-observed";
const TOOL_CALL_RESULT_EVENT_TYPE = "TOOL_CALL_RESULT";
// Fallback tool name for a persisted interrupt whose id has no corresponding
// entry in this run's tool-call buffer (RT-F5 non-BuiltInAgent shape — the
// interrupt's own `id` never matches a buffered `toolCallId` there). Cosmetic
// only: it never affects RT-F5 correlation, which always keys on `id`.
const UNKNOWN_INTERRUPT_TOOL_NAME = "unknown";

/**
 * Extract `EventWithState` from `Middleware.runNextWithState` return type so
 * we don't depend on a non-exported `@ag-ui/client` internal name.
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type EventWithState = ExtractObservableType<
  ReturnType<Middleware["runNextWithState"]>
>;

interface ToolCallBufferEntry {
  activityArgs?: unknown;
  activityStarted: boolean;
  args: string;
  argsDeltas: ToolCallArgsEventLike[];
  // RT-F4: present ONLY for a frontend+enforce call. Accumulates the raw
  // TOOL_CALL_START/ARGS/END events so they can be forwarded together once
  // the verdict resolves (or discarded entirely on block) — never forwarded
  // as they stream in, unlike an observed/telemetry call. Cleared (one-shot
  // flush, explicit `undefined` — not omission — hence the `| undefined`)
  // once `resolveForwardEvents` returns them.
  bufferedEvents?: BaseEvent[] | undefined;
  completed: boolean;
  endTime?: number;
  frontend: boolean;
  lastVerdict?: GovernanceVerdictResponse | null;
  startTime: number;
  toolName: string;
}

interface PerRunState {
  // The CopilotKit agent the run belongs to; titles the run's own rows.
  agentId: string | undefined;
  // Set once the run's terminal WorkflowFailed was sent by a gate refusal.
  closed: boolean;
  // Dedup keys for already-emitted handoffs:
  // `${multiAgentSessionId}::${fromAgentDid}::${childAgentName}::${parentActivityId}`.
  emittedHandoffs: Set<string>;
  // Resolved once per run when multi-agent mode is enabled; undefined disables
  // every multi-agent emission for this run.
  multiAgentSessionId: string | undefined;
  outputBuffers: Map<string, string>;
  outputText: string;
  // The interrupted run's id, when THIS run is a resume (RT-F5) — read off
  // `RunAgentInput.parentRunId` once at run start. `undefined` for a normal
  // (non-resume) run.
  parentRunId: string | undefined;
  // Parsed once (at run start) from `RunAgentInput.forwardedProps.resume` —
  // non-empty exactly when this run is resuming one or more prior interrupts.
  resumeEntries: ParsedResumeEntry[];
  runId: string;
  startTime: number;
  toolCallBuffer: Map<string, ToolCallBufferEntry>;
  userInput: unknown;
  workflowId: string;
  workflowStarted: boolean;
}

/**
 * AG-UI Middleware subclass that observes every event in the agent run stream
 * and emits OpenBox governance events via `OpenBoxCopilotKitEmitter`.
 *
 * Default is telemetry-only. `opts.enforceApprovals: true` opts in to await
 * `client.evaluate` + `client.pollApproval` once tool args are complete; on a
 * block/halt verdict the middleware injects a redacted `governance_blocked`
 * error frame (via `governance-blocked-error.ts`) into the observable.
 *
 * `frontendToolNames` / `isFrontendTool` are the explicit allowlist for
 * labelling a tool call `frontend: true`.
 */
export class OpenBoxMiddleware extends Middleware {
  readonly #emitter: OpenBoxCopilotKitEmitter;
  // Governs ONLY the frontend AG-UI TOOL_CALL_END gate (renamed from the
  // deprecated `enforceApprovals` boolean's field name — that boolean is now
  // one of several inputs `resolveFrontendEnforcement` resolves into this
  // flag; server-tool enforcement is an entirely separate boundary, see
  // `server-tool.ts`).
  readonly #frontendEnforce: boolean;
  readonly #frontendToolNames: string[] | undefined;
  readonly #isFrontendTool:
    | ((call: { name: string }) => boolean)
    | undefined;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #multiAgent: OpenBoxMultiAgentOptions | undefined;
  readonly #multiAgentEnabled: boolean;
  readonly #parentAgentDid: string | undefined;
  readonly #redactPaths: string[] | undefined;
  readonly #runtime: OpenBoxRuntimeController;
  readonly #spanBuffer: SpanBuffer | undefined;
  readonly #spanSynthesisDisabled: boolean;

  public constructor(
    runtime: OpenBoxRuntimeController,
    opts: OpenBoxMiddlewareOptions = {}
  ) {
    super();
    this.#runtime = runtime;
    this.#logger = runtime.logger;
    this.#emitter = new OpenBoxCopilotKitEmitter(runtime, opts.onEvent, opts.redactPaths);
    this.#frontendEnforce = resolveFrontendEnforcement(opts);
    // Deprecation warning fires ONLY when the deprecated boolean is the
    // DECIDING input (the caller has not set the explicit replacement) — an
    // operator who already migrated to `enforcement.frontendTools` should
    // never see noise about the boolean they are no longer relying on.
    if (opts.enforceApprovals === true && opts.enforcement?.frontendTools === undefined) {
      this.#logger.warn?.({
        note:
          "openbox middleware: `enforceApprovals: true` is deprecated (removed in 1.0.0) and now " +
          "enforces ONLY the frontend AG-UI TOOL_CALL_END gate. Server tools are NOT covered by this " +
          "flag — wrap them explicitly via `bundle.serverTool()` (see OpenBoxEnforcementOptions). " +
          "Set `middlewareOptions.enforcement.frontendTools` to silence this warning.",
        reason: "deprecated_enforce_approvals"
      });
    }
    this.#frontendToolNames = opts.frontendToolNames;
    this.#isFrontendTool = opts.isFrontendTool;
    this.#redactPaths = opts.redactPaths;
    this.#spanBuffer = opts.spanBuffer;
    this.#spanSynthesisDisabled = readSpanBufferEnv().disabled;

    this.#multiAgent = opts.multiAgent;
    this.#multiAgentEnabled = opts.multiAgent?.enabled === true;
    this.#parentAgentDid =
      opts.multiAgent?.parentAgentDid ?? runtime.runtime.config.agentDid ?? undefined;

    // Fail fast: multi-agent mode needs a parent DID to populate
    // `from_agent_did` on the Handoff. Without it OpenBox rejects the marker.
    if (this.#multiAgentEnabled && !this.#parentAgentDid) {
      throw new OpenBoxConfigError(
        "OpenBox multi-agent mode is enabled but no parent agent DID is available. " +
          "Set middlewareOptions.multiAgent.parentAgentDid or configure the runtime agentDid/agentPrivateKey."
      );
    }
  }

  public override run(
    input: RunAgentInput,
    next: AbstractAgent
  ): Observable<BaseEvent> {
    return this.#processStream(this.runNextWithState(input, next), input);
  }

  #processStream(
    source: Observable<EventWithState>,
    input: RunAgentInput
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      const state: PerRunState = {
        emittedHandoffs: new Set(),
        multiAgentSessionId: this.#resolveMultiAgentSessionId(
          input.runId,
          input.threadId
        ),
        outputBuffers: new Map(),
        outputText: "",
        parentRunId: input.parentRunId,
        resumeEntries: parseResumeEntries(input),
        runId: input.runId,
        startTime: Date.now(),
        toolCallBuffer: new Map(),
        userInput: extractLastUserMessage(input.messages),
        workflowId: input.threadId,
        workflowStarted: false,
        agentId: undefined,
        closed: false
      };

      let blocked = false;
      let pendingHandling = Promise.resolve();

      const enqueueHandling = (work: () => Promise<void>): void => {
        pendingHandling = pendingHandling.then(work).catch((err: unknown) => {
          // RT-F4: a genuine governance/control error must never be
          // laundered into a silent warn-and-continue — that would fail OPEN
          // on an enforcement decision. Nothing reaches this catch from
          // either of the two paths that make an enforcement decision today:
          // the frontend-tool gate below is RETURN-based (a block resolves
          // to `blockResult`, handled in `next` and never thrown), and every
          // telemetry send failure is isolated INSIDE the bounded queue
          // (`lifecycle-telemetry.ts`'s `failedTelemetrySends` +
          // `onDiagnostic`) — `#emitter.emit*()` never propagates a rejected
          // `evaluate` out to its caller. This catch is therefore a true
          // last-resort for an unrelated bug, not a place governance
          // decisions can be silently swallowed.
          this.#logger.warn?.({
            err,
            note: "openbox middleware handler error swallowed",
            workflow_id: state.workflowId
          });
        });
      };

      // Bind the per-run context store (D7) for the entire async lifetime of
      // this subscription — wrapping `source.subscribe` (not `run()`'s body
      // and not the RUN_STARTED handler) so `currentRunContext()` is
      // available to the tool-execution async chain the subscribe() call
      // sets up (Phase 5 reads it). Two concurrent runs never cross-observe
      // each other's ids (standard `AsyncLocalStorage` isolation).
      const subscription = this.#runtime.runContext.enterRunContext(
        { runId: input.runId, workflowId: input.threadId },
        () =>
          source.subscribe({
            next: eventWithState => {
              if (blocked) {
                return;
              }

              const event = eventWithState.event;

              enqueueHandling(async () => {
                const blockResult = await this.#handleEvent(state, event);
                if (blockResult) {
                  blocked = true;
                  subscriber.next(blockResult);
                  subscriber.complete();
                  return;
                }

                if (!blocked) {
                  // RT-F4: a frontend+enforce call's TOOL_CALL_START/ARGS/END
                  // triple is buffered (see `ToolCallBufferEntry.bufferedEvents`)
                  // rather than forwarded as it streams in — `resolveForwardEvents`
                  // returns `[]` while buffering, or the FULL held sequence once
                  // the verdict resolves as allow (a block already returned above
                  // via `blockResult`, discarding the buffer entirely). Every
                  // other event forwards unchanged (single-element array).
                  for (const forwardEvent of resolveForwardEvents(state, event)) {
                    subscriber.next(forwardEvent);
                  }
                }
              });
            },
            error: err => {
              enqueueHandling(async () => {
                await this.#emitWorkflowFailedFromError(state, err);
                subscriber.error(err);
              });
            },
            complete: () => {
              pendingHandling
                .then(() => {
                  if (!blocked) {
                    subscriber.complete();
                  }
                })
                .catch((complErr: unknown) => {
                  this.#logger.warn?.({
                    err: complErr,
                    note: "openbox middleware completion error swallowed",
                    workflow_id: state.workflowId
                  });
                  subscriber.complete();
                });
            }
          })
      );

      return () => {
        subscription.unsubscribe();
        // Defensive, idempotent cleanup of the queue's per-run truncation
        // flag for a run that never reaches a terminal telemetry event —
        // e.g. an early client-disconnect unsubscribe. The normal case
        // (terminal event observed) already clears it inside the queue
        // itself; the queue's chain-map bookkeeping self-cleans separately
        // once a run's own last send settles, regardless of this call.
        this.#runtime.telemetryQueue.endRun(state.runId);
      };
    });
  }

  async #handleEvent(
    state: PerRunState,
    event: BaseEvent
  ): Promise<GovernanceBlockedErrorEvent | undefined> {
    const context = getOpenBoxExecutionContext();
    const goal = context?.goal;
    const agentId = context?.agentId ?? this.#runtime.defaults.agentId;
    const metadata = context?.metadata;

    if (isToolCallResultEvent(event)) {
      const resultEvent = event as BaseEvent & {
        toolCallId?: string | undefined;
      };
      if (!resultEvent.toolCallId) {
        return undefined;
      }
      const entry = state.toolCallBuffer.get(resultEvent.toolCallId);
      if (!entry) {
        return undefined;
      }
      entry.activityArgs ??= parseToolArgs(entry.args);
      entry.endTime = Date.now();
      const blockResult = await this.#emitActivityStartedIfNeeded({
        activityId: resultEvent.toolCallId,
        agentId,
        entry,
        goal,
        metadata,
        state
      });
      if (blockResult) {
        return blockResult;
      }
      await this.#emitActivityCompleted({
        activityId: resultEvent.toolCallId,
        activityOutput: extractToolResultOutput(resultEvent),
        agentId,
        entry,
        goal,
        metadata,
        state,
        status: "completed"
      });
      state.toolCallBuffer.delete(resultEvent.toolCallId);
      return undefined;
    }

    switch (event.type) {
      case EventType.RUN_STARTED: {
        if (!state.workflowStarted) {
          state.workflowStarted = true;
          state.agentId = agentId;
          await this.#emitter.emitWorkflowStarted({
            agentId,
            goal,
            metadata,
            multiAgentSessionId: state.multiAgentSessionId,
            runId: state.runId,
            threadId: state.workflowId,
            userInput: state.userInput,
            workflowId: state.workflowId
          });
          // The run's one SignalReceived: the user's prompt as text.
          await this.#emitter.emitSignalReceived({
            goal,
            metadata,
            multiAgentSessionId: state.multiAgentSessionId,
            payload: extractUserText(state.userInput),
            runId: state.runId,
            signalName: USER_PROMPT_SIGNAL_NAME,
            workflowId: state.workflowId
          });
          this.#runtime.openRouterProvenance?.markRunStarted?.(state.runId);
        }
        return undefined;
      }

      case EventType.TOOL_CALL_START: {
        const toolCall = event as BaseEvent & {
          toolCallId: string;
          toolCallName: string;
        };
        const frontend = this.#isFrontend({ name: toolCall.toolCallName });
        // RT-F4: a frontend call under frontend-enforce buffers its own
        // START/ARGS/END triple (see `bufferedEvents` below) instead of
        // forwarding as it streams — holding only END (the pre-Phase-5
        // behavior) would already have let the browser act on fully-streamed
        // args before the verdict resolved.
        const bufferBeforeVerdict = frontend && this.#frontendEnforce;
        state.toolCallBuffer.set(toolCall.toolCallId, {
          activityStarted: false,
          args: "",
          argsDeltas: [],
          ...(bufferBeforeVerdict ? { bufferedEvents: [event] } : {}),
          completed: false,
          frontend,
          startTime: Date.now(),
          toolName: toolCall.toolCallName
        });
        return undefined;
      }

      case EventType.TOOL_CALL_ARGS: {
        const argsEvent = event as BaseEvent & {
          delta: string;
          toolCallId: string;
        };
        const entry = state.toolCallBuffer.get(argsEvent.toolCallId);
        if (entry) {
          entry.args += argsEvent.delta;
          entry.argsDeltas.push({
            delta: argsEvent.delta,
            toolCallId: argsEvent.toolCallId
          });
          entry.bufferedEvents?.push(event);
        }
        return undefined;
      }

      case EventType.TOOL_CALL_END: {
        const endEvent = event as BaseEvent & { toolCallId: string };
        const entry = state.toolCallBuffer.get(endEvent.toolCallId);
        if (!entry) {
          return undefined;
        }
        entry.activityArgs = parseToolArgs(entry.args);
        entry.endTime = Date.now();
        // Append END to the buffer BEFORE gating so a subsequent allow-path
        // flush (`resolveForwardEvents`, called by the caller once this
        // returns `undefined`) forwards the complete START/ARGS*/END sequence.
        entry.bufferedEvents?.push(event);

        if (!entry.frontend) {
          // RT-F15: a server (non-frontend) tool call MIGHT be claimed by a
          // `bundle.serverTool()` wrapper, but the AI SDK enqueues the
          // tool-call notification (leading to this very TOOL_CALL_END)
          // BEFORE it ever invokes the tool's real `execute` (verified: `ai`
          // package's own `executeToolCall`, fire-and-forget, a handful of
          // microtask-only `await`s deep — no timers/IO in between). Checking
          // ownership immediately here would race the wrapper's claim and
          // reliably LOSE. Yielding to the MACROTASK queue once — not a fixed
          // race-prone delay, but a structural guarantee that every currently
          // queued microtask (including that whole invoke-execute chain) has
          // already run by the time this resumes — gives the wrapper's
          // synchronous claim (the first line of its actual `execute`) time
          // to land before the ownership check below. A ScriptedAgent-driven
          // (non-wrapped) call has no such chain to wait for, so this is a
          // negligible one-tick delay for it — `isOwned` still correctly
          // resolves false and this proceeds exactly as before (preserves
          // e.g. the interrupt-tracking test's "ActivityStarted fires at
          // TOOL_CALL_END" expectation for an unwrapped call).
          await yieldToMacrotaskQueue();
        }

        const blockResult = await this.#emitActivityStartedIfNeeded({
          activityId: endEvent.toolCallId,
          agentId,
          entry,
          goal,
          metadata,
          state
        });
        if (blockResult) {
          return blockResult;
        }
        return undefined;
      }

      case EventType.TEXT_MESSAGE_START: {
        const startEvent = event as BaseEvent & { messageId: string };
        state.outputBuffers.set(startEvent.messageId, "");
        return undefined;
      }

      case EventType.TEXT_MESSAGE_CONTENT: {
        const contentEvent = event as BaseEvent & {
          delta: string;
          messageId: string;
        };
        const buffer = state.outputBuffers.get(contentEvent.messageId);
        if (buffer !== undefined) {
          state.outputBuffers.set(
            contentEvent.messageId,
            buffer + contentEvent.delta
          );
        }
        return undefined;
      }

      case EventType.TEXT_MESSAGE_END: {
        const endEvent = event as BaseEvent & { messageId: string };
        const text = state.outputBuffers.get(endEvent.messageId);
        if (text !== undefined) {
          state.outputBuffers.delete(endEvent.messageId);
          state.outputText += (state.outputText ? "\n" : "") + text;
        }
        return undefined;
      }

      case EventType.RUN_FINISHED: {
        return this.#handleRunFinished({
          agentId,
          endTime: Date.now(),
          event: event as RunFinishedEvent,
          goal,
          metadata,
          state
        });
      }

      case EventType.RUN_ERROR: {
        const errorEvent = event as BaseEvent & {
          code?: string;
          message?: string;
        };
        const error = {
          code: errorEvent.code,
          message: errorEvent.message ?? "Run failed"
        };
        const blockResult = await this.#flushPendingToolCalls({
          agentId,
          error,
          goal,
          metadata,
          state,
          status: "failed"
        });
        if (blockResult) {
          return blockResult;
        }
        await this.#emitter.emitWorkflowFailed({
          agentId: state.agentId,
          durationMs: Math.max(0, Date.now() - state.startTime),
          error,
          goal,
          metadata,
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          workflowId: state.workflowId
        });
        await this.#clearRunOnTerminal(state);
        return undefined;
      }

      default:
        return undefined;
    }
  }

  /**
   * `RUN_FINISHED` dispatcher (fixes B3). Outcome is parsed BEFORE any
   * flush. Order: resume correlation first — it closes out an ORIGINAL
   * (interrupted) run's dangling activity and is independent of THIS run's
   * own outcome — then interrupt (pending + one signal, no completion) or
   * success (unchanged pre-Phase-4 flush + signal + `WorkflowCompleted`).
   * Every branch ends in `#clearRunOnTerminal` (RT-F14).
   */
  async #handleRunFinished({
    agentId,
    endTime,
    event,
    goal,
    metadata,
    state
  }: {
    agentId?: string | undefined;
    endTime: number;
    event: RunFinishedEvent;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<GovernanceBlockedErrorEvent | undefined> {
    if (state.resumeEntries.length > 0) {
      const unresolvable = await this.#connectResumeEntries({ endTime, goal, metadata, state });
      if (unresolvable) {
        // RT-F9: a resume that cannot be correlated is a typed failure —
        // never a fabricated completion. Stop here; do not also evaluate
        // this run's own outcome.
        await this.#clearRunOnTerminal(state);
        return undefined;
      }
    }

    const outcome = parseRunOutcome(event, this.#redactPaths);

    if (outcome.kind === "interrupt") {
      await this.#handleInterruptOutcome({ interrupts: outcome.interrupts, state });
      // Keep this run's just-saved pending interrupts — a later resume run
      // reads them back via `interruptStore.take` (RT-F9).
      await this.#clearRunOnTerminal(state, { keepInterrupts: true });
      return undefined;
    }

    // Success (outcome undefined or {type:"success"}) — unchanged
    // pre-Phase-4 behavior: flush any frontend-only tool call (no
    // TOOL_CALL_RESULT companion event exists for those), then signal +
    // complete exactly once.
    const blockResult = await this.#flushPendingToolCalls({
      agentId,
      goal,
      metadata,
      state,
      status: "completed"
    });
    if (blockResult) {
      return blockResult;
    }
    this.#runtime.runTerminalState.markOutputEmitted(state.runId);
    await this.#emitter.emitWorkflowCompleted({
      agentId: state.agentId ?? agentId,
      agentOutput: state.outputText,
      durationMs: Math.max(0, endTime - state.startTime),
      endTime,
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      startTime: state.startTime,
      workflowId: state.workflowId
    });
    await this.#clearRunOnTerminal(state);
    return undefined;
  }

  /**
   * Interrupt outcome (fixes B3): persist one `PendingInterrupt` snapshot
   * per interrupt — keyed on the interrupt's own `id`, NEVER `toolCallId`
   * (RT-F5) — emit ONE `copilotkit_interrupt` signal, and mark the run
   * interrupted. Deliberately does NOT touch `state.toolCallBuffer`: every
   * buffered (unresolved) tool call stays PENDING because the run is
   * suspended, not finished — no `ActivityCompleted`, no `WorkflowCompleted`.
   */
  async #handleInterruptOutcome({
    interrupts,
    state
  }: {
    interrupts: readonly ParsedInterrupt[];
    state: PerRunState;
  }): Promise<void> {
    const pending: PendingInterrupt[] = interrupts.map(interrupt => {
      // Best-effort cosmetic lookup only (toolName/args/startTime for the
      // eventual resume completion) — NEVER used for correlation, which
      // always keys on `interrupt.id` alone (RT-F5). Absent on the
      // non-BuiltInAgent shape, where the interrupt carries no `toolCallId`
      // and its `id` never matches a buffered `toolCallId` either.
      const buffered = state.toolCallBuffer.get(interrupt.toolCallId ?? interrupt.id);
      return {
        activityId: interrupt.id,
        ...(buffered?.activityArgs !== undefined
          ? { activityArgs: buffered.activityArgs }
          : {}),
        ...(state.multiAgentSessionId !== undefined
          ? { multiAgentSessionId: state.multiAgentSessionId }
          : {}),
        ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
        reason: interrupt.reason,
        ...(buffered !== undefined ? { startTime: buffered.startTime } : {}),
        toolName: buffered?.toolName ?? UNKNOWN_INTERRUPT_TOOL_NAME,
        workflowId: state.workflowId
      };
    });

    this.#runtime.interruptStore.save(state.runId, pending, DEFAULT_INTERRUPT_TTL_MS);
    this.#runtime.runTerminalState.markInterrupted(state.runId);

    await this.#emitter.emitInterruptSignal({
      interruptIds: interrupts.map(i => i.id),
      messages: interrupts.map(i => i.message),
      multiAgentSessionId: state.multiAgentSessionId,
      reasons: interrupts.map(i => i.reason),
      responseSchemas: interrupts.map(i => i.responseSchema),
      runId: state.runId,
      workflowId: state.workflowId
    });
  }

  /**
   * Correlate every resume entry against the interrupt-persistence port
   * (RT-F5 — keyed on `interruptId`, i.e. the ORIGINAL interrupt's own
   * `id`), looked up under the ORIGINAL (interrupted) run's id —
   * `parentRunId` when present, else this run's own id. On a match: emit a
   * correcting `ActivityCompleted` attributed to the ORIGINAL run/workflow
   * ids (closing out the activity left dangling when it interrupted), with
   * `status` mapped from `resume.status` (`resolved` -> `completed`,
   * `cancelled` -> `aborted`) and `resume.payload` as the output. On a miss
   * (never interrupted, already resumed, or TTL-expired): emit a typed
   * `workflowFailed` and return `true` — RT-F9 forbids fabricating a
   * completion. Returns `true` on the FIRST unresolvable entry (stops the
   * loop — a run's own outcome is never evaluated after a resume failure).
   */
  async #connectResumeEntries({
    endTime,
    goal,
    metadata,
    state
  }: {
    endTime: number;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<boolean> {
    const originalRunId = state.parentRunId ?? state.runId;
    let originalWorkflowId: string | undefined;
    let originalMultiAgentSessionId: string | undefined;

    for (const entry of state.resumeEntries) {
      const pending = this.#runtime.interruptStore.take(originalRunId, entry.interruptId);
      if (!pending) {
        await this.#emitter.emitWorkflowFailed({
          agentId: state.agentId,
          durationMs: Math.max(0, Date.now() - state.startTime),
          error: {
            message: `Resume references an unknown or expired interrupt id: ${entry.interruptId}`,
            name: "OpenBoxInterruptResumeCorrelationError"
          },
          goal,
          metadata,
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          workflowId: state.workflowId
        });
        return true;
      }

      await this.#emitter.emitActivityCompleted({
        ...(pending.activityArgs !== undefined ? { activityArgs: pending.activityArgs } : {}),
        activityId: pending.activityId,
        ...(entry.payload !== undefined ? { activityOutput: entry.payload } : {}),
        ...(pending.startTime !== undefined
          ? {
              durationMs: Math.max(0, endTime - pending.startTime),
              startTime: pending.startTime
            }
          : {}),
        endTime,
        goal,
        metadata,
        ...(pending.multiAgentSessionId !== undefined
          ? { multiAgentSessionId: pending.multiAgentSessionId }
          : {}),
        runId: originalRunId,
        status: entry.status === "resolved" ? "completed" : "aborted",
        toolName: pending.toolName,
        workflowId: pending.workflowId
      });
      originalWorkflowId = pending.workflowId;
      originalMultiAgentSessionId = pending.multiAgentSessionId;
    }

    // The interrupted run suspended without a terminal event; once its last
    // interrupt is resolved, it is over. (A resume under the same run id is
    // closed by this run's own outcome instead.)
    const interrupts = this.#runtime.interruptStore;
    if (
      originalRunId !== state.runId &&
      originalWorkflowId !== undefined &&
      !(interrupts.hasPending?.(originalRunId) ?? false)
    ) {
      await this.#emitter.emitWorkflowCompleted({
        agentId: state.agentId,
        goal,
        metadata,
        multiAgentSessionId: originalMultiAgentSessionId,
        runId: originalRunId,
        workflowId: originalWorkflowId
      });
      interrupts.clearRun(originalRunId);
    }

    return false;
  }

  /**
   * RT-F14 terminal cleanup — called on every RUN_FINISHED/RUN_ERROR path.
   * `contextStore.clearHalt` bounds the BASE per-run HALT set: the base has
   * no stop-signal FIFO, so a finished run's HALT entry would otherwise
   * live until process shutdown; this consumer owns clearing it once the
   * run's stream is truly over, regardless of outcome kind.
   * `interruptStore.clearRun` is SKIPPED when `keepInterrupts` is set — an
   * interrupt outcome persists fresh entries in this SAME call, and a later
   * resume run must still be able to `take()` them back.
   * `serverToolOwnership.releaseRun` (RT-F15) bulk-releases every
   * `bundle.serverTool()` ownership claim made during this run — the wrapper
   * deliberately does NOT self-release real (non-generated) correlation per
   * call (see `server-tool.ts`'s release-site comment: doing so would race
   * this middleware's own deferred TOOL_CALL_RESULT/flush ownership check
   * and lose every time), so this run-terminal sweep is the ONE place those
   * claims are guaranteed to be cleaned up, called AFTER every flush path
   * above has already had its chance to observe them.
   * `childAgentClients.releaseRun` (RT-F10) awaits + drops this run's own
   * tracked in-flight Handoff emissions — in practice always already settled
   * by this point (`#maybeEmitHandoff` is awaited by its own caller before
   * any terminal event is processed), so this is a defensive drain rather
   * than a source of added latency; async so this method's own caller awaits
   * it, keeping the run's terminal path from resolving before it completes.
   */
  async #clearRunOnTerminal(
    state: PerRunState,
    opts: { keepInterrupts?: boolean } = {}
  ): Promise<void> {
    this.#runtime.runtime.contextStore.clearHalt(state.workflowId, state.runId);
    if (!opts.keepInterrupts) {
      this.#runtime.interruptStore.clearRun(state.runId);
    }
    this.#runtime.serverToolOwnership.releaseRun(state.runId);
    await this.#runtime.childAgentClients.releaseRun(state.runId);
  }

  /**
   * Flush every still-buffered (unresolved) tool call with the given
   * terminal `status`. Used by BOTH the success path (`status: "completed"`
   * — frontend tools never produce a `TOOL_CALL_RESULT`, so RUN_FINISHED is
   * their only completion point) and the RUN_ERROR/source-error paths
   * (`status: "failed"`, carrying the run's own `error`). NEVER called for
   * an interrupt outcome — an interrupted run's buffered calls must stay
   * PENDING (fixes B3; see `#handleInterruptOutcome`).
   */
  async #flushPendingToolCalls({
    agentId,
    error,
    goal,
    metadata,
    state,
    status
  }: {
    agentId?: string | undefined;
    error?: Record<string, unknown> | undefined;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
  }): Promise<GovernanceBlockedErrorEvent | undefined> {
    for (const [activityId, entry] of state.toolCallBuffer) {
      entry.activityArgs ??= parseToolArgs(entry.args);
      entry.endTime ??= Date.now();
      const blockResult = await this.#emitActivityStartedIfNeeded({
        activityId,
        agentId,
        entry,
        goal,
        metadata,
        state
      });
      if (blockResult) {
        return blockResult;
      }
      await this.#emitActivityCompleted({
        activityId,
        agentId,
        entry,
        ...(error !== undefined ? { error } : {}),
        goal,
        metadata,
        state,
        status
      });
      state.toolCallBuffer.delete(activityId);
    }
    return undefined;
  }

  async #emitActivityStartedIfNeeded({
    activityId,
    agentId,
    entry,
    goal,
    metadata,
    state
  }: {
    activityId: string;
    agentId?: string | undefined;
    entry: ToolCallBufferEntry;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<GovernanceBlockedErrorEvent | undefined> {
    if (entry.activityStarted) {
      return undefined;
    }

    // The model call that chose this tool closes before the tool starts.
    await this.#runtime.openRouterProvenance?.settleRun?.(state.runId);

    // RT-F15 duplicate-suppression: a wrapped server tool
    // (`bundle.serverTool()`) already claimed `(runId, toolCallId)` ownership
    // and emitted its OWN ActivityStarted/Completed for this call (Phase 5).
    // Suppress BOTH halves of the observer's emission — `entry.completed =
    // true` short-circuits the later `#emitActivityCompleted` call via its
    // own `if (entry.completed) return;` guard — while the raw AG-UI event
    // keeps flowing to the client unchanged (this method never touches event
    // forwarding). Keyed on the tuple, NEVER on tool name (RT-F5/RT-F15).
    if (this.#runtime.serverToolOwnership.isOwned(state.runId, activityId)) {
      entry.activityStarted = true;
      entry.completed = true;
      return undefined;
    }

    const activityStartedInput: ActivityStartedInput = {
      activityArgs: entry.activityArgs,
      activityId,
      agentId,
      frontend: entry.frontend,
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      toolName: entry.toolName,
      toolOrigin: TOOL_ORIGIN,
      workflowId: state.workflowId
    };

    if (this.#frontendEnforce) {
      // RT-F4: the caller (`#processStream`'s `next` handler, via
      // `resolveForwardEvents`) buffers this call's TOOL_CALL_START/ARGS/END
      // triple and only forwards it once this resolves as allow — never
      // forwarded as it streams in, unlike telemetry/observed calls.
      const enforced = await this.#emitActivityStartedEnforced(activityStartedInput);
      entry.activityStarted = true;
      entry.lastVerdict = enforced.verdict;
      if (enforced.blockEvent) {
        await this.#closeRefusedRun({
          agentId,
          failure: enforced.failure ?? { message: "Blocked by governance", name: "GovernanceBlockedError" },
          goal,
          metadata,
          state
        });
        return enforced.blockEvent;
      }
      // A blocked delegation never hands off; the Handoff is emitted only after a
      // non-blocking parent ActivityStarted, mirroring the expected sequence
      // (parent ActivityStarted → child Handoff → child WorkflowStarted).
      await this.#maybeEmitHandoff({ activityId, entry, state });
      return undefined;
    }

    // Telemetry-only mode (unchanged): enqueue and never block.
    const verdict = await this.#emitter.emitActivityStarted(activityStartedInput);
    entry.activityStarted = true;
    entry.lastVerdict = verdict;
    await this.#maybeEmitHandoff({ activityId, entry, state });
    return undefined;
  }

  /**
   * The enforcing pre-execution gate (fixes B2). Builds the ActivityStarted
   * envelope + fires `onEvent` for observability (both pure, no send — see
   * `prepareActivityStartedForEnforcement`), then routes the ACTUAL send
   * through the base `OpenBoxRuntime.evaluateLifecycle()`: gate-prep +
   * `client.evaluate` + REQUIRE_APPROVAL wait (`waitForDecision`, via the
   * Phase-2 poller) + BLOCK/HALT raise all happen INSIDE that one call — this
   * method never enqueues on the telemetry queue and never calls
   * `client.evaluate` a second time (no double-send).
   *
   * `evaluateLifecycle` only returns normally for ALLOW, or for
   * REQUIRE_APPROVAL that resolved as APPROVED (the returned `result.verdict`
   * is left as `"require_approval"` in that case — `handleApproval` resolving
   * without throwing is what "approved" means, per the base runtime). Reject/
   * expire/timeout/BLOCK/HALT all THROW a base error before returning. CONSTRAIN
   * is the one verdict the adapter has no action for and also returns
   * normally (D5) — so it is the only "returned normally" case this method
   * must itself reject, by throwing `CopilotKitUnsupportedVerdictError`
   * BEFORE any delivery/handoff.
   *
   * Every throw path (base control errors, the unsupported-verdict error, and
   * any OTHER exception — auth/signing/contract/network) is caught here and
   * translated to the SAME redacted `governance_blocked` frame: this gate is
   * pre-delivery, so any failure to reach a definite ALLOW must fail CLOSED,
   * never a silent allow.
   */
  async #emitActivityStartedEnforced(
    input: ActivityStartedInput
  ): Promise<{
    blockEvent: GovernanceBlockedErrorEvent | undefined;
    failure?: Record<string, unknown>;
    verdict: GovernanceVerdictResponse | null;
  }> {
    const envelope = this.#emitter.prepareActivityStartedForEnforcement(input);
    try {
      // The run's queued events (WorkflowStarted, the prompt) reach Core first.
      await this.#runtime.telemetryQueue.drainRun(input.runId);
      const result = await this.#runtime.runtime.evaluateLifecycle(envelope);
      if (!isProceedableVerdict(result.verdict)) {
        throw new CopilotKitUnsupportedVerdictError(
          result.verdict,
          correlationIdFromResult(result)
        );
      }
      // Bridge to this SDK's local `GovernanceVerdictResponse` shape (span/audit
      // `policyVersion` reads `policyId` off it): every field this SDK reads
      // off a verdict (`verdict`, `reason`, `policyId`, `governanceEventId`,
      // `approvalId`, ...) is named identically on both shapes, so the cast is
      // safe — mirrors the same bridge `openbox-emitter.ts#evaluate` already
      // documents and relies on.
      return { blockEvent: undefined, verdict: result as unknown as GovernanceVerdictResponse };
    } catch (err) {
      const controlError = toGovernanceControlError(err);
      this.#logger.warn?.({
        err: controlError,
        note: "openbox enforce gate: tool call blocked at the CopilotKit boundary",
        reason: controlError.reason,
        workflow_id: input.workflowId
      });
      return {
        blockEvent: createGovernanceBlockedErrorEvent(resolveEnforcementCorrelationId(err)),
        failure: { message: controlError.message, name: controlError.name },
        verdict: null
      };
    }
  }

  async #emitActivityCompleted({
    activityId,
    activityOutput,
    agentId,
    entry,
    error,
    goal,
    metadata,
    state,
    status
  }: {
    activityId: string;
    activityOutput?: unknown;
    agentId?: string | undefined;
    entry: ToolCallBufferEntry;
    error?: Record<string, unknown> | undefined;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
  }): Promise<void> {
    if (entry.completed) {
      return;
    }
    const endTime = entry.endTime ?? Date.now();
    const span = this.#synthesizeToolSpanOrNull({
      activityId,
      activityOutput,
      endTime,
      entry,
      state,
      status
    });
    await this.#emitter.emitActivityCompleted({
      activityArgs: entry.activityArgs,
      activityId,
      ...(activityOutput !== undefined ? { activityOutput } : {}),
      durationMs: Math.max(0, endTime - entry.startTime),
      endTime,
      ...(error !== undefined ? { error } : {}),
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      startTime: entry.startTime,
      status,
      toolName: entry.toolName,
      workflowId: state.workflowId
    });
    if (span) {
      await this.#emitter.emitActivityCompletedHook({
        activityArgs: entry.activityArgs,
        activityId,
        agentId,
        durationMs: Math.max(0, endTime - entry.startTime),
        endTime,
        goal,
        metadata,
        runId: state.runId,
        span,
        startTime: entry.startTime,
        workflowId: state.workflowId
      });
      this.#spanBuffer?.append(state.workflowId, span);
    }
    entry.completed = true;
  }

  #synthesizeToolSpanOrNull({
    activityId,
    activityOutput,
    endTime,
    entry,
    state,
    status
  }: {
    activityId: string;
    activityOutput?: unknown;
    endTime: number;
    entry: ToolCallBufferEntry;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
  }): SpanData | null {
    if (this.#spanSynthesisDisabled || !this.#spanBuffer) {
      return null;
    }
    try {
      const span = synthesizeToolSpan(
        {
          activityId,
          args: entry.argsDeltas,
          attempt: 0,
          end: {
            toolCallId: activityId,
            ...(activityOutput !== undefined ? { result: activityOutput } : {})
          },
          endTimeUnixNano: BigInt(endTime) * 1_000_000n,
          runId: state.runId,
          start: {
            toolCallId: activityId,
            toolCallName: entry.toolName
          },
          startTimeUnixNano: BigInt(entry.startTime) * 1_000_000n,
          workflowId: state.workflowId
        },
        {
          isError: status !== "completed",
          ...(this.#redactPaths ? { redactPaths: this.#redactPaths } : {})
        }
      );

      attachAuditEnvelope(span, {
        activityId,
        attempt: 0,
        enforcementStatus: "pre_execution_allowed",
        gateway: "agui_event",
        ...(entry.lastVerdict?.policyId
          ? { policyVersion: entry.lastVerdict.policyId }
          : {}),
        runId: state.runId,
        workflowId: state.workflowId
      });

      return span;
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox tool-span synthesis failed",
        workflow_id: state.workflowId
      });
      return null;
    }
  }

  /**
   * End a run the enforcing gate refused (block, halt, or a rejected/expired
   * approval): the blocked AG-UI stream ends here, so Core must see the run
   * end too. Every activity already reported as started is closed as failed
   * (the refused one included); calls never reported are dropped — they never
   * ran. No new evaluation is requested. Then WorkflowFailed, then the run's
   * state is released.
   */
  async #closeRefusedRun({
    agentId,
    failure,
    goal,
    metadata,
    state
  }: {
    agentId?: string | undefined;
    failure: Record<string, unknown>;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<void> {
    if (state.closed) {
      return;
    }
    state.closed = true;
    for (const [activityId, entry] of state.toolCallBuffer) {
      if (entry.activityStarted && !entry.completed) {
        entry.activityArgs ??= parseToolArgs(entry.args);
        entry.endTime ??= Date.now();
        await this.#emitActivityCompleted({
          activityId,
          agentId,
          entry,
          error: failure,
          goal,
          metadata,
          state,
          status: "failed"
        });
      }
    }
    state.toolCallBuffer.clear();
    await this.#emitter.emitWorkflowFailed({
      agentId: state.agentId ?? agentId,
      durationMs: Math.max(0, Date.now() - state.startTime),
      error: failure,
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      workflowId: state.workflowId
    });
    await this.#clearRunOnTerminal(state);
  }

  async #emitWorkflowFailedFromError(
    state: PerRunState,
    err: unknown
  ): Promise<void> {
    const context = getOpenBoxExecutionContext();
    const error = {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : "Error"
    };
    // Flush unresolved activities as failed before the workflow failure
    // (mirrors the RUN_ERROR path). A governance block surfaced by this
    // flush has nowhere meaningful to go here — the source stream is
    // already erroring and `subscriber.error(err)` follows unconditionally
    // in the caller — so its return value is intentionally not applied to
    // a client-visible event; Core still sees a failed completion per
    // dangling activity.
    await this.#flushPendingToolCalls({
      error,
      goal: context?.goal,
      metadata: context?.metadata,
      state,
      status: "failed"
    });
    if (state.closed) {
      return;
    }
    await this.#emitter.emitWorkflowFailed({
      agentId: state.agentId,
      durationMs: Math.max(0, Date.now() - state.startTime),
      error,
      goal: context?.goal,
      metadata: context?.metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      workflowId: state.workflowId
    });
    await this.#clearRunOnTerminal(state);
  }

  #isFrontend(call: { name: string }): boolean {
    if (this.#isFrontendTool) {
      return this.#isFrontendTool(call);
    }
    if (this.#frontendToolNames?.includes(call.name)) {
      return true;
    }
    return false;
  }

  #resolveMultiAgentSessionId(
    runId: string,
    workflowId: string
  ): string | undefined {
    if (!this.#multiAgentEnabled) {
      return undefined;
    }
    const configured = this.#multiAgent?.multiAgentSessionId;
    if (typeof configured === "function") {
      return configured(this.#sessionContext(runId, workflowId));
    }
    if (typeof configured === "string" && configured.length > 0) {
      return configured;
    }
    // Default prefix must stay `mas:` — the OpenBox Mastra SDK and @ag-ui/mastra
    // derive the child's session id as `mas:${runId}` from the same forwarded
    // run id. Any other prefix here splits one delegated run into two OpenBox
    // multi-agent sessions (parent vs child). The prefix also keeps the value
    // distinguishable from a raw provider run id.
    return `mas:${runId}`;
  }

  #sessionContext(
    runId: string,
    workflowId: string
  ): MultiAgentSessionContext {
    return {
      parentAgentDid: this.#parentAgentDid ?? "",
      runId,
      threadId: workflowId,
      workflowId
    };
  }

  #resolveHandoffConfig(
    call: OpenBoxObservedToolCall,
    state: PerRunState
  ): OpenBoxSubagentHandoffConfig | undefined {
    const ctx = this.#sessionContext(state.runId, state.workflowId);
    const dynamic = this.#multiAgent?.resolveHandoff?.(call, ctx);
    if (dynamic) {
      return dynamic;
    }
    return this.#multiAgent?.handoffTools?.[call.name];
  }

  #forwardMultiAgentContext(
    ctx: OpenBoxMultiAgentContext,
    state: PerRunState
  ): Record<string, unknown> | undefined {
    const adapter = this.#multiAgent?.forwardContext;
    if (!adapter) {
      return undefined;
    }
    try {
      return adapter(ctx) ?? undefined;
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox multi-agent: forwardContext adapter threw — swallowed",
        workflow_id: state.workflowId
      });
      return undefined;
    }
  }

  /**
   * If the just-started activity maps to a configured subagent, emit exactly
   * one `Handoff` per delegation. Sent as the child agent (so Core resolves
   * `to_agent` correctly) when child credentials are configured; otherwise the
   * prepared `OpenBoxMultiAgentContext` is surfaced via `onEvent` for a remote
   * child to emit. Fully isolated from the event pipeline — never throws.
   *
   * RT-F10: a blocked parent `ActivityStarted` never reaches this method at
   * all (the caller only invokes it on the non-blocking path — see
   * `#emitActivityStartedIfNeeded`), so a blocked delegation already emits
   * nothing without any check here. Once bundle/runtime shutdown has begun
   * (`childAgentClients.isShuttingDown`), this method fails the delegation
   * the SAME way — no child client, no `onEvent` context-export fallback
   * either — since the cache backing both is being torn down concurrently.
   */
  async #maybeEmitHandoff({
    activityId,
    entry,
    state
  }: {
    activityId: string;
    entry: ToolCallBufferEntry;
    state: PerRunState;
  }): Promise<void> {
    try {
      if (!this.#multiAgentEnabled || !state.multiAgentSessionId) {
        return;
      }
      const parentAgentDid = this.#parentAgentDid;
      if (!parentAgentDid) {
        return;
      }
      if (this.#runtime.childAgentClients.isShuttingDown) {
        this.#logger.debug?.({
          note: "openbox multi-agent: shutdown in progress — refusing this delegation, no Handoff emitted",
          workflow_id: state.workflowId
        });
        return;
      }

      const config = this.#resolveHandoffConfig(
        { args: entry.activityArgs, name: entry.toolName, toolCallId: activityId },
        state
      );
      if (!config) {
        return;
      }

      const childAgentName = config.childAgentName ?? entry.toolName;
      const dedupeKey = `${state.multiAgentSessionId}::${parentAgentDid}::${childAgentName}::${activityId}`;
      if (state.emittedHandoffs.has(dedupeKey)) {
        return;
      }
      state.emittedHandoffs.add(dedupeKey);

      const multiAgentContext: OpenBoxMultiAgentContext = {
        multiAgentSessionId: state.multiAgentSessionId,
        parentActivityId: activityId,
        parentAgentDid,
        parentRunId: state.runId,
        parentWorkflowId: state.workflowId
      };

      // Hand the context to the operator's forwarding adapter (e.g. to stash it
      // for the delegate tool to set on the child's RuntimeContext).
      const forwarded = this.#forwardMultiAgentContext(multiAgentContext, state);

      const handoffMetadata: Record<string, unknown> = {
        child_agent_name: childAgentName,
        ...(config.childTaskQueue
          ? { child_task_queue: config.childTaskQueue }
          : {}),
        ...(config.childWorkflowType
          ? { child_workflow_type: config.childWorkflowType }
          : {}),
        delegate_tool_name: entry.toolName,
        ...(forwarded ? { forwarded_context: forwarded } : {}),
        openbox_multi_agent_context: multiAgentContext,
        parent_activity_id: activityId,
        parent_workflow_id: state.workflowId
      };

      const childClient = this.#buildChildClient(config);
      if (!childClient) {
        this.#logger.debug?.({
          multi_agent_session_id: state.multiAgentSessionId,
          note: "openbox multi-agent: handoff context prepared without child credentials — a remote child runtime must emit the Handoff",
          workflow_id: state.workflowId
        });
      }

      // Track the promise BEFORE awaiting it (RT-F10): a concurrent
      // bundle/runtime shutdown's `childAgentClients.close()` must be able to
      // observe and await this SAME in-flight send even if it runs before
      // this call settles, never let the process exit mid signing-or-send.
      const handoffPromise = this.#emitter.emitHandoff(
        {
          fromAgentDid: parentAgentDid,
          metadata: handoffMetadata,
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          taskQueue: COPILOTKIT_TASK_QUEUE,
          workflowId: state.workflowId,
          workflowType: COPILOTKIT_WORKFLOW_TYPE
        },
        childClient
      );
      this.#runtime.childAgentClients.trackHandoff(state.runId, handoffPromise);
      await handoffPromise;
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox multi-agent: handoff emission failed — swallowed",
        workflow_id: state.workflowId
      });
    }
  }

  /**
   * Build (or reuse) the child-scoped BASE client this delegation's Handoff
   * is signed with. A child CLIENT is sufficient (YAGNI) — a full child
   * `OpenBoxRuntime` would additionally cost an `ApprovalPoller`/`ContextStore`
   * this call never needs (the child only signs + sends ONE `client.evaluate`
   * for the Handoff, never a HITL-gated activity of its own). Cached by
   * `controller.childAgentClients` (RT-F10), keyed on `childAgentDid`, shared
   * across every delegation this CONTROLLER serves (not just this middleware
   * instance).
   */
  #buildChildClient(
    config: OpenBoxSubagentHandoffConfig
  ): OpenBoxClient | undefined {
    const { childAgentDid, childAgentPrivateKey, childApiKey } = config;
    if (!childApiKey || !childAgentDid || !childAgentPrivateKey) {
      return undefined;
    }

    try {
      return this.#runtime.childAgentClients.getOrCreate(childAgentDid, () => {
        // Child-scoped base config: only the credentials that IDENTIFY the
        // child differ from the parent's own resolved config —
        // apiUrl/onApiError/timeoutSeconds/sdk* are inherited so a delegated
        // call follows the SAME outage/timeout/SDK-identity policy as the
        // parent runtime. `OpenBoxConfig.resolve()` validates eagerly
        // (agentDid format, apiKey `obx_(live|test)_*` pattern, https/localhost
        // apiUrl) and throws synchronously on a violation — caught below.
        const parentConfig = this.#runtime.runtime.config;
        const childConfig = OpenBoxConfig.resolve({
          agentDid: childAgentDid,
          agentPrivateKey: childAgentPrivateKey,
          apiKey: childApiKey,
          apiUrl: parentConfig.apiUrl,
          onApiError: parentConfig.onApiError,
          sdkEngine: parentConfig.sdkEngine,
          sdkLanguage: parentConfig.sdkLanguage,
          sdkVersion: parentConfig.sdkVersion,
          timeoutSeconds: parentConfig.timeoutSeconds
        });
        return new OpenBoxClient(childConfig.apiUrl, childConfig.apiKey, {
          identity: childConfig.loadIdentity(),
          onApiError: childConfig.onApiError,
          sdkEngine: childConfig.sdkEngine,
          sdkLanguage: childConfig.sdkLanguage,
          sdkVersion: childConfig.sdkVersion,
          timeoutSeconds: childConfig.timeoutSeconds
        });
      });
    } catch (err) {
      // Bad child DID/key/URL must not crash the run — degrade to context-export.
      this.#logger.warn?.({
        err,
        note: "openbox multi-agent: failed to build child-scoped client (check child DID / private key) — falling back to context-export only"
      });
      return undefined;
    }
  }
}

/** Factory for the AG-UI middleware. */
export function createOpenBoxMiddleware(
  runtime: OpenBoxRuntimeController,
  opts: OpenBoxMiddlewareOptions = {}
): OpenBoxMiddleware {
  return new OpenBoxMiddleware(runtime, opts);
}

function extractLastUserMessage(
  messages: RunAgentInput["messages"] | undefined
): unknown {
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate !== undefined &&
      typeof candidate === "object" &&
      (candidate as { role?: string }).role === "user"
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Reduce a user message to its text content for the array-shaped timeline
 * signal. Falls back to the original value when content is not a plain string
 * (e.g. multi-part content) — the emitter then array-wraps it and the backend
 * JSON-stringifies element 0.
 */
function extractUserText(message: unknown): unknown {
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
  }
  return message;
}

/**
 * Resolve once every currently-queued MICROTASK has run (a macrotask/timer
 * callback is ordered strictly after the ENTIRE microtask queue drains,
 * regardless of how many hops deep it is) — used at TOOL_CALL_END (RT-F15)
 * to let a `bundle.serverTool()` wrapper's own microtask-only "invoke
 * execute" chain finish before checking `serverToolOwnership.isOwned`.
 */
function yieldToMacrotaskQueue(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Resolve the frontend AG-UI `TOOL_CALL_END` gate's observe/enforce flag from
 * the explicit `OpenBoxEnforcementOptions` model, falling back to the
 * deprecated `enforceApprovals` boolean, per the precedence documented on
 * `OpenBoxMiddlewareOptions.enforceApprovals`:
 *
 *   1. `enforcement.frontendTools` explicit — wins outright.
 *   2. `enforceApprovals === true` (deprecated) — frontend-only enforcement.
 *   3. `enforcement.mode === "enforce"` — `frontendTools` follows `mode`.
 *   4. Otherwise observe (telemetry default).
 */
function resolveFrontendEnforcement(opts: OpenBoxMiddlewareOptions): boolean {
  const explicit = opts.enforcement?.frontendTools;
  if (explicit === "enforce") {
    return true;
  }
  if (explicit === "observe") {
    return false;
  }
  if (opts.enforceApprovals === true) {
    return true;
  }
  return opts.enforcement?.mode === "enforce";
}

/**
 * RT-F4: decide what to forward downstream for one event. Only
 * TOOL_CALL_START/ARGS/END belonging to a buffering call (frontend+enforce,
 * see `bufferBeforeVerdict` at TOOL_CALL_START) are held — every other event
 * forwards unchanged (`[event]`), matching the pre-Phase-5 behavior exactly.
 *
 * - START/ARGS while still buffering → `[]` (held; already appended to
 *   `entry.bufferedEvents` by the caller in `#handleEvent`).
 * - END while buffering → the FULL accumulated sequence, flushed once (a
 *   block never reaches here: `#handleEvent` already returned the redacted
 *   frame directly, so the buffer is simply discarded with `state` — never
 *   forwarded).
 */
function resolveForwardEvents(state: PerRunState, event: BaseEvent): BaseEvent[] {
  const toolCallId = bufferableToolCallId(event);
  if (!toolCallId) {
    return [event];
  }
  const entry = state.toolCallBuffer.get(toolCallId);
  if (!entry?.bufferedEvents) {
    return [event];
  }
  if (event.type !== EventType.TOOL_CALL_END) {
    return [];
  }
  const buffered = entry.bufferedEvents;
  entry.bufferedEvents = undefined;
  return buffered;
}

/** `toolCallId` for the 3 buffer-relevant event types only; `undefined` for everything else (incl. TOOL_CALL_RESULT). */
function bufferableToolCallId(event: BaseEvent): string | undefined {
  switch (event.type) {
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END: {
      const withId = event as BaseEvent & { toolCallId?: string };
      return withId.toolCallId;
    }
    default:
      return undefined;
  }
}

function parseToolArgs(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isToolCallResultEvent(event: BaseEvent): boolean {
  return String(event.type) === TOOL_CALL_RESULT_EVENT_TYPE;
}

function extractToolResultOutput(event: BaseEvent): unknown {
  const record = event as unknown as Record<string, unknown>;
  for (const key of ["result", "output", "content", "value", "data"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return parseMaybeJsonString(record[key]);
    }
  }
  return undefined;
}

function parseMaybeJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * Verdicts `evaluateLifecycle()` can return WITHOUT throwing that mean
 * "proceed": ALLOW, and REQUIRE_APPROVAL that resolved as approved (its
 * `result.verdict` is left as `"require_approval"` — `handleApproval`
 * resolving instead of throwing is what "approved" means). BLOCK/HALT never
 * reach this check (they always throw first); CONSTRAIN reaches it and is
 * deliberately NOT in this set (D5 — the adapter has no enforcement action
 * for it, so the caller must reject it explicitly). Written as an allow-list
 * (not `!== CONSTRAIN`) so a hypothetical future verdict the base SDK adds
 * fails closed here by default, not open.
 */
const PROCEEDABLE_VERDICTS: ReadonlySet<Verdict> = new Set([
  Verdict.ALLOW,
  Verdict.REQUIRE_APPROVAL
]);

// Exported: `server-tool.ts`'s enforce-mode gate reuses this same allow-list
// (its own CONSTRAIN/unsupported-verdict check) rather than redefining it —
// one definition of "proceed" shared by the frontend gate and the
// server-tool wrapper.
export function isProceedableVerdict(verdict: Verdict): boolean {
  return PROCEEDABLE_VERDICTS.has(verdict);
}

/**
 * Best-effort correlation id off a base `EvaluationResult` — same fallback
 * shape the pre-migration `resolveCorrelationId` used (`governanceEventId` ??
 * `approvalId` ?? `"unknown"`). Used for the ONE case this gate can inspect a
 * full result before failing it: CONSTRAIN (D5). Exported for `server-tool.ts`'s
 * matching CONSTRAIN check (DRY — same fallback shape, not redefined).
 */
export function correlationIdFromResult(result: EvaluationResult): string {
  return result.governanceEventId ?? result.approvalId ?? "unknown";
}

/**
 * Correlation id for the redacted `governance_blocked` frame when the gate
 * caught a THROWN error rather than inspecting a returned result.
 * `CopilotKitUnsupportedVerdictError` carries the id it was constructed with
 * (from `correlationIdFromResult` above). Every OTHER caught error — the base
 * `GovernanceBlockedError`/`GovernanceHaltError`/`ApprovalRejectedError`/
 * `ApprovalExpiredError`/`ApprovalTimeoutError`, or any unrecognized
 * exception — carries no `governanceEventId`/`approvalId` at all (verified:
 * `openbox-sdk-ts@1.0.1` `errors/index.ts` and `adapters/base.ts` construct
 * every one of these from a verdict/reason STRING only; `context/index.ts`'s
 * `ContextStore` tracks boolean halt/abort flags, never the originating
 * `EvaluationResult`) — `"unknown"` is the same fallback the pre-migration
 * code already used for a missing id.
 */
function resolveEnforcementCorrelationId(err: unknown): string {
  if (err instanceof CopilotKitUnsupportedVerdictError) {
    return err.correlationId;
  }
  return "unknown";
}

/**
 * Translate whatever `evaluateLifecycle()` (or this gate's own CONSTRAIN
 * check) threw into a `CopilotKitGovernanceControlError`. The base control
 * errors and `CopilotKitUnsupportedVerdictError` map to their matching
 * reason; anything else (auth/signing rejection, `GovernanceAPIError`,
 * network failure, or any other unexpected throw) maps to `"evaluation_error"`
 * — the enforcement boundary fails CLOSED on every path through this
 * function, never converting an error into an allow.
 *
 * Exported: `server-tool.ts`'s wrapper reuses this SAME translation for its
 * own `evaluateLifecycle()` catch — one mapping from base error to
 * `CopilotKitGovernanceControlError.reason` shared by both enforcement
 * boundaries (frontend gate + wrapped server tool), so an operator's
 * `err.reason` handling does not depend on which boundary blocked the call.
 */
export function toGovernanceControlError(err: unknown): CopilotKitGovernanceControlError {
  if (err instanceof CopilotKitUnsupportedVerdictError) {
    return new CopilotKitGovernanceControlError("unsupported_verdict", err.message, {
      cause: err
    });
  }
  if (err instanceof GovernanceHaltError) {
    return new CopilotKitGovernanceControlError("halt", err.message, { cause: err });
  }
  if (err instanceof GovernanceBlockedError) {
    return new CopilotKitGovernanceControlError("blocked", err.message, { cause: err });
  }
  if (err instanceof ApprovalRejectedError) {
    return new CopilotKitGovernanceControlError("approval_rejected", err.message, {
      cause: err
    });
  }
  if (err instanceof ApprovalExpiredError) {
    return new CopilotKitGovernanceControlError("approval_expired", err.message, {
      cause: err
    });
  }
  if (err instanceof ApprovalTimeoutError) {
    return new CopilotKitGovernanceControlError("approval_timeout", err.message, {
      cause: err
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new CopilotKitGovernanceControlError("evaluation_error", message, { cause: err });
}

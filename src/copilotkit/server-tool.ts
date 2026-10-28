import { randomUUID } from "node:crypto";

import { ActivityContext, type EvaluationResult } from "@openbox-ai/openbox-sdk-ts";

import { getOpenBoxExecutionContext } from "../governance/context.js";

import { CopilotKitGovernanceControlError } from "./governance-control-error.js";
import {
  COPILOTKIT_TASK_QUEUE,
  COPILOTKIT_WORKFLOW_TYPE,
  buildActivityStartedEnvelope,
  serializeOrNull
} from "./lifecycle-events.js";
import {
  correlationIdFromResult,
  isProceedableVerdict,
  toGovernanceControlError
} from "./openbox-middleware.js";
import { OpenBoxCopilotKitEmitter } from "./openbox-emitter.js";
import { CopilotKitServerToolCorrelationError } from "./server-tool-correlation-error.js";
import type { OpenBoxEnforcementOptions, OpenBoxRuntimeController } from "./types.js";
import { CopilotKitUnsupportedVerdictError } from "./unsupported-verdict-error.js";

export { CopilotKitServerToolCorrelationError } from "./server-tool-correlation-error.js";

/** Distinguishes a wrapped-server-tool activity from an AG-UI-observed one in telemetry. */
export const COPILOTKIT_SERVER_TOOL_ORIGIN = "copilotkit-server-tool";

/** The (loosely-typed) second argument the AI SDK v6 tool-execution pump calls `execute` with. */
export interface ServerToolExecutionOptionsLike {
  toolCallId?: unknown;
  [key: string]: unknown;
}

type ServerToolExecute = (
  args: unknown,
  executionOptions?: ServerToolExecutionOptionsLike
) => Promise<unknown>;

/**
 * Structural shape `serverTool()` needs off an arbitrary tool object (e.g.
 * `@copilotkit/runtime/v2`'s `ToolDefinition`, the return value of
 * `defineTool()`). Declared with `unknown` fields (not the peer's own type)
 * so this module never needs to import the peer's `ToolDefinition` type.
 */
interface ServerToolShape {
  execute?: unknown;
  name?: unknown;
}

/**
 * Wrap a real server-side tool `execute` so OpenBox evaluates (and, in
 * `enforce` mode, awaits approval for) the call BEFORE the side effect runs —
 * the pre-execution boundary `test/integration/builtin-agent-server-tool-gate.test.ts`
 * proves an UNWRAPPED tool does not have (B1). `T` is intentionally
 * unconstrained (matches `bundle.serverTool<T>(tool): T`): a governed tool
 * can be any shape a framework SDK produces, and this function only reads
 * `execute`/`name` off it via a narrow internal cast — constraining `T`
 * would force every caller's concrete tool type (whose `execute` is typed
 * with ONE declared parameter even though the AI SDK invokes it with a
 * second `executionOptions` argument at runtime, per
 * `test/contract/copilotkit-execution-options.test.ts`) to satisfy an
 * assignability check it has no reason to model.
 *
 * Order (phase-05 "Run correlation" pseudocode): read the per-run context
 * store + `executionOptions.toolCallId` (compat-guarded) -> fail safe in
 * enforce mode when either is missing -> claim `(runId, toolCallId)`
 * ownership (RT-F15) -> evaluate (enforce: the real gate; telemetry:
 * best-effort, non-blocking) -> reject CONSTRAIN/unsupported verdicts
 * explicitly (D5) -> run `realExecute` EXACTLY ONCE inside the base
 * `ContextStore.activityScope` -> emit ActivityCompleted -> return/rethrow.
 *
 * Ownership RELEASE is deliberately NOT symmetric with the claim for real
 * (non-generated) correlation — see the comment at the release site: the AI
 * SDK invokes `execute` asynchronously, well after the tool-call is already
 * observable on the AG-UI stream (verified against `ai`'s own
 * `executeToolCall`), so the observer's own duplicate-suppression check can
 * only run reliably at TOOL_CALL_RESULT/RUN_FINISHED-flush time — often
 * AFTER this wrapped call has already settled. Releasing immediately here
 * would make that later check deterministically miss. The claim instead
 * lives for the rest of the run, released in bulk by the run's own terminal
 * cleanup (`openbox-middleware.ts#clearRunOnTerminal`).
 */
export function serverTool<T>(
  tool: T,
  controller: OpenBoxRuntimeController,
  enforcementOptions: OpenBoxEnforcementOptions = {}
): T {
  const shape = tool as T & ServerToolShape;
  const realExecute = shape.execute;
  if (typeof realExecute !== "function") {
    // Nothing to govern -- e.g. an interrupt-only ToolDefinition (`interrupt:
    // true`) has no `execute` at all. Passthrough unchanged.
    return tool;
  }
  const boundExecute = realExecute as ServerToolExecute;

  const toolName = typeof shape.name === "string" && shape.name.length > 0 ? shape.name : "unknown_tool";
  const mode = enforcementOptions.mode ?? "telemetry";
  // No `onEvent`/`redactPaths` seam on this path today (`OpenBoxEnforcementOptions`
  // carries neither) -- the wrapper's own telemetry is unobserved by the
  // AG-UI middleware's `onEvent` hook. Reusing the same emitter class keeps
  // wire-shape/privacy handling identical to the AG-UI observer path (DRY).
  const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

  const wrapped: ServerToolExecute = async (args, executionOptions) => {
    const execCtx = getOpenBoxExecutionContext();
    const goal = execCtx?.goal;
    const agentId = execCtx?.agentId ?? controller.defaults.agentId;
    const metadata = execCtx?.metadata;

    const runCtx = controller.runContext.currentRunContext();
    const seamActivityId = compatToolCallId(executionOptions);

    let workflowId: string;
    let runId: string;
    let activityId: string;
    let correlationGenerated = false;

    if (runCtx && seamActivityId) {
      workflowId = runCtx.workflowId;
      runId = runCtx.runId;
      activityId = seamActivityId;
    } else if (mode === "enforce") {
      const missing = { runContext: !runCtx, toolCallId: !seamActivityId };
      // LOUD: a missing correlation in enforce mode is a fail-safe disabling
      // hard enforcement for this call -- never silently downgrade to late
      // AG-UI blocking (that would resurrect the B1 overclaim this phase fixes).
      controller.logger.warn?.({
        has_run_context: Boolean(runCtx),
        has_tool_call_id: Boolean(seamActivityId),
        note:
          "openbox serverTool: enforce mode requires run correlation but it was missing -- " +
          "failing safe, execute will NOT run for this call.",
        tool_name: toolName
      });
      throw new CopilotKitServerToolCorrelationError(toolName, missing);
    } else {
      // Telemetry mode: never gate on a missing correlation -- synthesize IDs
      // marked `generated` and keep going (spec: "Telemetry mode may
      // synthesize an activity id marked generated").
      workflowId = runCtx?.workflowId ?? `generated-workflow:${randomUUID()}`;
      runId = runCtx?.runId ?? `generated-run:${randomUUID()}`;
      activityId = seamActivityId ?? `generated-activity:${randomUUID()}`;
      correlationGenerated = true;
    }

    const startTime = Date.now();
    // Claim ownership as the FIRST action inside this `execute` -- RT-F15.
    // The AI SDK enqueues the tool-call notification onto the AG-UI-facing
    // stream BEFORE it invokes `execute` (verified: `ai`'s own
    // `executeToolCall`, fire-and-forget, several `await`s deep) -- so the
    // observer's TOOL_CALL_END often runs BEFORE this line, and its
    // suppression check is deliberately deferred to TOOL_CALL_RESULT/the
    // RUN_FINISHED-flush instead (see `openbox-middleware.ts`'s TOOL_CALL_END
    // handling), both of which can only fire after `execute` was invoked (if
    // it ever is) -- so the claim below is always in place by then.
    controller.serverToolOwnership.claim(runId, activityId);

    const activityArgs = serializeOrNull(args);
    const emittedMetadata = correlationGenerated
      ? { ...(metadata ?? {}), openbox_correlation: "generated" }
      : metadata;

    const completeAndRelease = async (
      outcome: { output: unknown; status: "completed" } | { error: unknown; status: "failed" }
    ): Promise<void> => {
      try {
        await emitter.emitActivityCompleted({
          activityArgs,
          activityId,
          ...(agentId !== undefined ? { agentId } : {}),
          durationMs: Math.max(0, Date.now() - startTime),
          endTime: Date.now(),
          ...(goal !== undefined ? { goal } : {}),
          ...(emittedMetadata !== undefined ? { metadata: emittedMetadata } : {}),
          runId,
          startTime,
          status: outcome.status,
          toolName,
          workflowId,
          ...(outcome.status === "completed"
            ? { activityOutput: outcome.output }
            : { error: toErrorRecord(outcome.error) })
        });
      } finally {
        if (correlationGenerated) {
          // No real AG-UI run will ever query this SYNTHETIC key (a
          // `generated-*` id never matches a real `(runId, toolCallId)` an
          // observer looks up) -- self-release immediately so a high-volume
          // telemetry-mode caller without any per-run context never leaks an
          // unbounded claim per call.
          controller.serverToolOwnership.release(runId, activityId);
        }
        // REAL correlation: deliberately NOT released here. Verified (`ai`
        // package's `executeToolCall`, dist/index.mjs): the AI SDK enqueues
        // the "tool-call" part onto the consumer stream BEFORE it ever
        // invokes `execute` (fire-and-forget, several `await`s later) -- so
        // the AG-UI observer's TOOL_CALL_RESULT/RUN_FINISHED-flush handling
        // can only run AFTER `execute` was invoked, but that is often AFTER
        // this wrapped call already settled. Releasing here would make
        // `isOwned()` deterministically false by the time the observer
        // checks it, defeating RT-F15 suppression. The claim instead lives
        // for the REST of the run and is released in bulk by the owning
        // run's OWN terminal cleanup (`openbox-middleware.ts#clearRunOnTerminal`
        // -> `serverToolOwnership.releaseRun`).
      }
    };

    try {
      if (mode === "enforce") {
        // The REAL pre-execution gate. `evaluateLifecycle` prepares +
        // evaluates + (on REQUIRE_APPROVAL) awaits the base ApprovalPoller,
        // and throws directly on BLOCK/HALT/rejected/expired/timed-out --
        // reused as-is (RT-F12), never a custom adapter.
        //
        // RT-F3: this envelope carries no `spans` (it is a lifecycle event,
        // not a hook/span evaluation), so the base client's
        // `fail_closed_destructive` policy (which only fails closed for a
        // DESTRUCTIVE SPAN) degrades to fail-OPEN here on a Core outage --
        // documented base behavior (`payloadHasDestructiveSpan`, base SDK
        // 1.0.1 `client/index.ts`), asserted by
        // `test/integration/builtin-agent-server-tool-gate.test.ts`. Operators
        // who need hard outage blocking for server tools must configure
        // `onApiError: "fail_closed"`, not `"fail_closed_destructive"`. This
        // gate never routes through `preflight` either way.
        const envelope = buildActivityStartedEnvelope({
          activityArgs,
          activityId,
          ...(agentId !== undefined ? { agentId } : {}),
          frontend: false,
          ...(goal !== undefined ? { goal } : {}),
          ...(emittedMetadata !== undefined ? { metadata: emittedMetadata } : {}),
          runId,
          toolName,
          toolOrigin: COPILOTKIT_SERVER_TOOL_ORIGIN,
          workflowId
        });

        let evalResult: EvaluationResult;
        try {
          // The run's queued events (WorkflowStarted, the prompt) reach Core first.
          await controller.telemetryQueue.drainRun(runId);
          evalResult = await controller.runtime.evaluateLifecycle(envelope);
        } catch (err) {
          throw toGovernanceControlError(err);
        }

        if (!isProceedableVerdict(evalResult.verdict)) {
          // CONSTRAIN (or any future unsupported verdict): the base runtime
          // RETURNS this normally (no adapter action, D5) -- the wrapper
          // must reject it explicitly BEFORE execute, never a silent allow.
          throw toGovernanceControlError(
            new CopilotKitUnsupportedVerdictError(
              evalResult.verdict,
              correlationIdFromResult(evalResult)
            )
          );
        }
      } else {
        // Telemetry mode: best-effort, non-blocking observation via the SAME
        // bounded queue the AG-UI observer uses. A telemetry hiccup must
        // never gate `execute` -- swallow and continue.
        try {
          await emitter.emitActivityStarted({
            activityArgs,
            activityId,
            ...(agentId !== undefined ? { agentId } : {}),
            frontend: false,
            ...(goal !== undefined ? { goal } : {}),
            ...(emittedMetadata !== undefined ? { metadata: emittedMetadata } : {}),
            runId,
            toolName,
            toolOrigin: COPILOTKIT_SERVER_TOOL_ORIGIN,
            workflowId
          });
        } catch (telemetryErr) {
          controller.logger.warn?.({
            err: telemetryErr,
            note: "openbox serverTool: telemetry-mode activityStarted emission failed -- swallowed (execute still runs)",
            tool_name: toolName
          });
        }
      }
    } catch (gateErr) {
      await completeAndRelease({ error: gateErr, status: "failed" });
      throw gateErr;
    }

    let result: unknown;
    try {
      // Base `ContextStore.activityScope` binds the base SDK's per-activity
      // ALS around the real tool body (distinct from `controller.runContext`,
      // Decision D7) so any instrumented HTTP/DB/file/function call INSIDE
      // the tool resolves its enclosing activity correctly.
      result = await controller.runtime.contextStore.activityScope(
        new ActivityContext({
          activityId,
          activityInput: activityArgs,
          activityType: toolName,
          runId,
          taskQueue: COPILOTKIT_TASK_QUEUE,
          workflowId,
          workflowType: COPILOTKIT_WORKFLOW_TYPE
        }),
        () => boundExecute(args, executionOptions)
      );
    } catch (execErr) {
      await completeAndRelease({ error: execErr, status: "failed" });
      throw execErr;
    }

    await completeAndRelease({ output: result, status: "completed" });
    return result;
  };

  return { ...shape, execute: wrapped };
}

/** Optional-chained, type-guarded read of `executionOptions.toolCallId` (the compat guard). */
function compatToolCallId(executionOptions: ServerToolExecutionOptionsLike | undefined): string | undefined {
  const toolCallId = executionOptions?.toolCallId;
  return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
}

/** Same `{message, name}` shape `openbox-middleware.ts` already uses for a caught error's ActivityCompleted/WorkflowFailed record. */
function toErrorRecord(err: unknown): Record<string, unknown> {
  if (err instanceof CopilotKitGovernanceControlError) {
    return { message: err.message, name: err.name, reason: err.reason };
  }
  if (err instanceof Error) {
    return { message: err.message, name: err.name };
  }
  return { message: String(err), name: "Error" };
}

import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { SpanBuffer } from "../spans/span-buffer.js";

import type { ChildAgentClientCache } from "./internal/child-agent-client-cache.js";
import type { OpenBoxInstrumentationOptions } from "./internal/instrumentation.js";
import type { InterruptPersistencePort } from "./internal/interrupt-store.js";
import type { RunContextStore } from "./internal/run-context-store.js";
import type { RunTerminalStateRegistry } from "./internal/run-terminal-state.js";
import type { ServerToolOwnershipRegistry } from "./internal/server-tool-ownership.js";
import type { LifecycleTelemetryQueue, TelemetryQueueOptions } from "./lifecycle-telemetry.js";

/**
 * Lightweight logger contract. Module-local; matches a console-style surface
 * so adopters can pass console, pino, winston, or a custom shim without an
 * extra adapter.
 */
export interface OpenBoxLogger {
  debug?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Runtime defaults consulted by emissions when the per-request execution
 * context is absent.
 */
export interface OpenBoxRuntimeDefaults {
  agentId?: string | undefined;
  tenantId?: string | undefined;
  workflowType?: string | undefined;
}

/**
 * Wire-level dependencies attached to an OpenBox-wrapped CopilotRuntime.
 *
 * `runtime` is the ONE base `OpenBoxRuntime` this controller owns (config,
 * client, adapter, and the base per-runtime `ContextStore` all live on it —
 * see `internal/base-runtime-builder.ts`). `runContext` is a SEPARATE,
 * small, controller-owned per-run store (Decision D7) — do not conflate the
 * two. `telemetryQueue` is the ONE bounded, non-blocking telemetry sender
 * (Phase 3, fixes B4) this controller owns — constructed once alongside
 * `runtime` so cross-run concurrency/pending bounds apply across every
 * request this controller serves, never per-middleware-instance.
 * `serverToolOwnership` is a run-scoped `(runId, toolCallId)` registry
 * the server-tool wrapper (Phase 5) claims to suppress a duplicate AG-UI
 * observation for the same call. `interruptStore` is the MANDATORY
 * injectable pending-interrupt persistence port (RT-F9/P2-10) — the
 * in-memory default is documented as non-durable, never a process-global.
 * `runTerminalState` is the per-run output-dedup/interrupted registry
 * (RT-F14) shared by the AG-UI middleware and `internal/after-request.ts`.
 * `childAgentClients` is the cache of child-scoped base clients multi-agent
 * Handoff emission signs with (RT-F10) — one instance per controller, closed
 * by bundle/runtime shutdown and drained per-run on that run's terminal path.
 */
export interface OpenBoxRuntimeController {
  runtime: OpenBoxRuntime;
  runContext: RunContextStore;
  telemetryQueue: LifecycleTelemetryQueue;
  defaults: OpenBoxRuntimeDefaults;
  logger: OpenBoxLogger;
  serverToolOwnership: ServerToolOwnershipRegistry;
  interruptStore: InterruptPersistencePort;
  runTerminalState: RunTerminalStateRegistry;
  childAgentClients: ChildAgentClientCache;
  /**
   * Reports OpenRouter model calls made during this controller's runs (see
   * `internal/openrouter-provenance.ts`). A run's closing event waits for the
   * run's pending provenance via `drainRun`.
   */
  openRouterProvenance?: { drainRun: (runId: string) => Promise<void> } | undefined;
}

/**
 * Explicit enforcement model (proposal §7.3) replacing the ambiguous
 * `enforceApprovals` boolean. Governs TWO independent boundaries — see the
 * Boundaries table in `plans/260716-1509-openbox-sdk-ts-adoption/phase-05-explicit-server-tool-governance.md`:
 *
 *   - Wrapped `BuiltInAgent` server tools (`bundle.serverTool()`, see
 *     `server-tool.ts`): `mode: "enforce"` runs the base
 *     `OpenBoxRuntime.evaluateLifecycle()` gate BEFORE the tool's real
 *     `execute` runs — BLOCK/HALT/a rejected-or-expired-or-timed-out approval/
 *     CONSTRAIN all prevent `execute` from ever running, and the wrapper
 *     THROWS (server tools surface errors to their caller; there is no AG-UI
 *     stream frame to redact into). `mode: "telemetry"` (default) never
 *     gates: `execute` always runs, and ActivityStarted/Completed telemetry
 *     is recorded best-effort (a missing per-run correlation is marked
 *     `generated` rather than silently omitted).
 *   - The frontend AG-UI `TOOL_CALL_END` gate (`frontendTools`): independent
 *     of `mode` by default it FOLLOWS `mode`, but can diverge (e.g. enforce
 *     server tools while only observing frontend/browser tool calls).
 *
 * `unwrappedServerTools` intentionally has NO `"enforce"` value: a server
 * tool never passed through `bundle.serverTool()` has no pre-execution seam
 * this SDK can hook (no wrapped `execute`), so it is ALWAYS observation-only
 * — this field documents that boundary in types rather than toggling any
 * behavior.
 */
export interface OpenBoxEnforcementOptions {
  /** Governs wrapped server tools (`bundle.serverTool()`). Default `"telemetry"`. */
  mode?: "telemetry" | "enforce";
  /** Governs the frontend AG-UI `TOOL_CALL_END` gate. Default: follows `mode`. */
  frontendTools?: "observe" | "enforce";
  /**
   * Documents that an unwrapped server tool / MCP tool / external-agent call
   * is always observation-only. No `"enforce"` value exists for this seam —
   * see the interface doc above.
   */
  unwrappedServerTools?: "observe";
  /**
   * HITL approval poll interval. Default `5_000`ms — matches the base
   * `ApprovalPoller`'s own default exactly, so this is a no-op today: wiring
   * a NON-default value through to the live poller requires constructing it
   * inside `internal/base-runtime-builder.ts`'s composition root, which is
   * out of this phase's scope (tracked as a follow-up, not silently dropped).
   */
  approvalPollIntervalMs?: number;
  /**
   * Bounds an in-flight HITL approval wait; explicit `null` opts into an
   * infinite wait. Default `900_000` (15 min). Mirrors
   * `CreateOpenBoxCopilotKitOptions.approvalMaxWaitMs` (that field wins when
   * both are set on `createOpenBoxCopilotKit`).
   */
  approvalMaxWaitMs?: number | null;
}

/**
 * Operator-facing options for `createOpenBoxMiddleware`.
 *
 * `frontendToolNames` / `isFrontendTool` are the explicit allowlist required
 * to label a tool call as frontend-originated. Without them, observed tool
 * calls record `frontend: false` and `tool_origin: "copilotkit-observed"`
 * (safe default for multi-framework runtimes).
 *
 * `multiAgent` opts the run into OpenBox multi-agent grouping: it stamps a
 * shared `multi_agent_session_id` on every event and emits a `Handoff` marker
 * when a configured delegation tool fires. Disabled by default — normal
 * single-agent governance is unchanged unless `multiAgent.enabled` is set.
 */
export interface OpenBoxMiddlewareOptions {
  /**
   * @deprecated Replaced by `enforcement` (`OpenBoxEnforcementOptions`) —
   * removed in `1.0.0`. `false` (the default) behaves like
   * `enforcement: { mode: "telemetry" }`. `true` behaves like
   * `enforcement: { frontendTools: "enforce" }` ONLY — the frontend AG-UI
   * `TOOL_CALL_END` gate — plus a one-time runtime warning that server tools
   * are NOT covered by this flag (wrap them explicitly via
   * `bundle.serverTool()`). NEVER treated as universal server-tool
   * enforcement. When both `enforceApprovals` and `enforcement.frontendTools`
   * are set, `enforcement.frontendTools` wins.
   */
  enforceApprovals?: boolean;
  /**
   * Explicit enforcement model (replaces `enforceApprovals`). See
   * `OpenBoxEnforcementOptions`.
   */
  enforcement?: OpenBoxEnforcementOptions;
  frontendToolNames?: string[];
  isFrontendTool?: (call: { name: string }) => boolean;
  multiAgent?: OpenBoxMultiAgentOptions;
  onEvent?: (emission: OpenBoxEmission) => void;
  /**
   * Optional external `SpanBuffer` instance. When provided, the middleware
   * synthesizes one `function_call` span per tool call at activity-completed
   * time and appends it to this buffer. When absent, the middleware skips
   * synthesis.
   *
   * Env override `OPENBOX_DISABLE_SPAN_BUFFER=1` skips synthesis regardless
   * of whether a buffer was provided.
   */
  spanBuffer?: SpanBuffer;
  /**
   * Optional JSONPath-like paths to redact from tool args/result previews.
   * Recommended starter set: `["$..password", "$..secret", "$..token", "$..apiKey"]`.
   * Applied both as a precise CopilotKit-side redactor on raw activity/signal
   * fields AND translated into the base gate's key-name `redactKeys` (RT-F2).
   */
  redactPaths?: string[];
  /**
   * Bounded, non-blocking telemetry-queue configuration (fixes B4). Read ONCE
   * — at the first `createOpenBoxMiddleware`/`withOpenBoxRuntime` call that
   * builds this controller's `telemetryQueue` (see `internal/base-runtime-builder.ts`);
   * the queue is a single instance shared by every run this controller
   * serves, so a later `createOpenBoxMiddleware` call on the SAME controller
   * cannot reconfigure it. The deprecated `maxEvaluatePayloadBytes` config
   * field (Phase 6) maps onto `maxPayloadBytes` here as a fallback only when
   * this option doesn't already set it — see `internal/config-translator.ts`.
   */
  telemetry?: TelemetryQueueOptions;
  /**
   * Opt-in base instrumentation (Phase 6, proposal §14) — OFF by default in
   * `0.4.0`; no target (fetch/http/https/fs/db) is ever patched unless
   * `enabled: true` is set here. Read ONCE, same construction-time semantics
   * as `telemetry` above (see `internal/base-runtime-builder.ts`). Shutdown
   * always calls the installed controller's `flush()` then `shutdown()`
   * before the runtime closes, restoring every patched global.
   */
  instrumentation?: OpenBoxInstrumentationOptions;
}

/**
 * Multi-agent delegation configuration. When `enabled`, the CopilotKit run is
 * treated as the PARENT/orchestrator of one OpenBox multi-agent session.
 *
 * Identity model: the CopilotKit runtime and each subagent are DISTINCT
 * OpenBox agents with their own API key + DID. The parent DID becomes the
 * `from_agent_did` on the Handoff, and child credentials identify the
 * receiving agent.
 */
export interface OpenBoxMultiAgentOptions {
  /** Master switch. Defaults to `false`. */
  enabled?: boolean;
  /**
   * DID of the parent/orchestrator agent, used as `from_agent_did` on the
   * Handoff. Falls back to the runtime client's `agentDid` when omitted. If
   * neither is available while `enabled` is true, middleware construction
   * throws `OpenBoxConfigError`.
   */
  parentAgentDid?: string;
  /**
   * Stable id grouping every session of one user-facing run. A string is used
   * verbatim; a function resolves it per run. Defaults to `mas:${runId}`.
   */
  multiAgentSessionId?: string | ((ctx: MultiAgentSessionContext) => string);
  /** Static tool-name → subagent map. Checked after `resolveHandoff`. */
  handoffTools?: Record<string, OpenBoxSubagentHandoffConfig>;
  /**
   * Dynamic resolver for delegation boundaries. Returns a subagent config to
   * treat the tool call as a handoff, or `null`/`undefined` to fall through to
   * `handoffTools` (and then to "normal tool, no handoff").
   */
  resolveHandoff?: (
    call: OpenBoxObservedToolCall,
    ctx: MultiAgentSessionContext
  ) => OpenBoxSubagentHandoffConfig | null | undefined;
  /**
   * Adapter invoked at each delegation boundary with the built
   * `OpenBoxMultiAgentContext`. Use it to forward the context to the child
   * runtime — e.g. stash it (keyed by `parentActivityId`) so the delegate tool
   * can attach it to the child invocation's `RuntimeContext`. Any record it
   * returns is merged into the Handoff metadata under `forwarded_context`.
   * CopilotKit-side only; it never edits child SDKs. Errors are swallowed.
   */
  forwardContext?: (
    ctx: OpenBoxMultiAgentContext
  ) => Record<string, unknown> | undefined;
}

/**
 * Per-subagent delegation config. The `child*` credentials are required only
 * for PARENT-SIDE Handoff emission (the SDK signs the Handoff request as the
 * child so Core resolves `to_agent` correctly). When they are absent the SDK
 * still builds + surfaces the `OpenBoxMultiAgentContext` (via `onEvent`) so a
 * remote child runtime can emit the Handoff itself.
 */
export interface OpenBoxSubagentHandoffConfig {
  /** Human/agent label for the child; defaults to the delegate tool name. */
  childAgentName?: string;
  childAgentDid?: string;
  childApiKey?: string;
  childAgentPrivateKey?: string;
  /** Child workflow_type recorded in Handoff metadata (e.g. "weather-agent"). */
  childWorkflowType?: string;
  /** Child task_queue recorded in Handoff metadata (for example, "weather"). */
  childTaskQueue?: string;
}

/**
 * Run-level context passed to the `multiAgentSessionId` resolver and
 * `resolveHandoff`. `workflowId` mirrors the CopilotKit `threadId`.
 */
export interface MultiAgentSessionContext {
  parentAgentDid: string;
  runId: string;
  threadId: string;
  workflowId: string;
}

/**
 * A tool call as observed by the middleware, handed to `resolveHandoff`.
 * `args` is the parsed tool argument object (or the raw string if it was not
 * valid JSON), and may be `undefined` before args have streamed in.
 */
export interface OpenBoxObservedToolCall {
  args?: unknown;
  name: string;
  toolCallId: string;
}

/**
 * The handoff context the parent makes available for a child runtime to emit
 * its own `Handoff` + stamp `parent_workflow_id` on its workflow events. It is
 * embedded in the Handoff payload metadata and surfaced via `onEvent`.
 */
export interface OpenBoxMultiAgentContext {
  multiAgentSessionId: string;
  parentActivityId: string;
  parentAgentDid: string;
  parentRunId: string;
  parentWorkflowId: string;
}

/**
 * Read-only structural projection of an OpenBox event surfaced to the
 * `onEvent` observability hook. Matches the canonical payload shape so
 * adopters can route to their own sinks without re-coupling.
 */
export interface OpenBoxEmission {
  activityId?: string | undefined;
  eventType: string;
  payload: Record<string, unknown>;
  workflowId: string;
}

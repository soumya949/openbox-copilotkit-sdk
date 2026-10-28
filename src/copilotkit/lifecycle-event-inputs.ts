/**
 * Adapter-shaped input types for the six lifecycle/signal builders in
 * `lifecycle-events.ts`. Split out purely to keep that file's builder logic
 * focused (module split, no behavior change) — every field here is preserved
 * verbatim from the pre-migration hand-built-payload inputs.
 */

/**
 * Optional OpenBox multi-agent fields, mixed into emitter inputs. Both are
 * omitted from the wire payload when unset, so single-agent runs keep their
 * normal payload shape.
 */
export interface MultiAgentEventFields {
  multiAgentSessionId?: string | undefined;
  parentWorkflowId?: string | undefined;
}

export interface WorkflowStartedInput extends MultiAgentEventFields {
  agentId?: string | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  threadId: string;
  userInput?: unknown;
  workflowId: string;
}

export interface SignalEmitInput {
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  multiAgentSessionId?: string | undefined;
  payload: unknown;
  runId: string;
  signalName: string;
  workflowId: string;
}

export interface ActivityStartedInput {
  activityArgs?: unknown;
  activityId: string;
  agentId?: string | undefined;
  frontend: boolean;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  multiAgentSessionId?: string | undefined;
  runId: string;
  toolName: string;
  toolOrigin: string;
  workflowId: string;
}

export interface ActivityCompletedInput {
  activityArgs?: unknown;
  activityId: string;
  activityOutput?: unknown;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  error?: Record<string, unknown> | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  multiAgentSessionId?: string | undefined;
  runId: string;
  startTime?: number | undefined;
  status: "completed" | "failed" | "aborted";
  toolName: string;
  workflowId: string;
}

export interface WorkflowCompletedInput extends MultiAgentEventFields {
  agentId?: string | undefined;
  agentOutput?: unknown;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  startTime?: number | undefined;
  workflowId: string;
}

export interface WorkflowFailedInput extends MultiAgentEventFields {
  agentId?: string | undefined;
  durationMs?: number | undefined;
  error: Record<string, unknown>;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  workflowId: string;
}

/**
 * `copilotkit_interrupt` signal input (fixes B3). Every array is parallel
 * (same length/order as the parsed `outcome.interrupts`) — `interruptIds`
 * are the AG-UI interrupt `id`s (RT-F5, never `toolCallId`); `responseSchemas`
 * are already redacted/bounded by `run-outcome.ts` before this input is built.
 */
export interface InterruptSignalInput {
  goal?: string | undefined;
  interruptIds: readonly string[];
  messages: ReadonlyArray<string | undefined>;
  metadata?: Record<string, unknown> | undefined;
  multiAgentSessionId?: string | undefined;
  reasons: readonly string[];
  responseSchemas: readonly unknown[];
  runId: string;
  workflowId: string;
}

/**
 * `Handoff` marker input (Decision D1) — the ONLY two fields the base
 * `handoff()` factory accepts. Unlike every other input above, this carries
 * no adapter-framework extras (`goal`/`metadata`/run-workflow ids/...): Core's
 * `ValidateHandoffPayload` needs nothing else, and the factory has no `extra`
 * bag to carry them even if it wanted to. `openbox-emitter.ts#emitHandoff`
 * still surfaces the richer adapter-shaped metadata via `onEvent`/logs — see
 * that method's own doc — but the wire envelope built from this input is
 * strictly two-field.
 */
export interface HandoffEnvelopeInput {
  fromAgentDid: string;
  multiAgentSessionId: string;
}

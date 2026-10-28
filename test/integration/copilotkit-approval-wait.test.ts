/**
 * Phase 4b (fixes B2 + D5): proves the frontend `TOOL_CALL_END` enforce gate
 * routes through the base `OpenBoxRuntime.evaluateLifecycle()` instead of a
 * direct `client.evaluate` call. Uses the base SDK's `conformance` kit
 * (`FakeCore` + `buildConformanceRuntime` + `APPROVAL_SCENARIOS`) so
 * REQUIRE_APPROVAL genuinely polls through a real `ApprovalPoller` — not a
 * synchronous simulation — proving the gate actually WAITS.
 *
 * Every scenario below asserts two things: (1) the client-visible frame (a
 * redacted `governance_blocked` RUN_ERROR, or none on approve), and (2) that
 * the triggering `TOOL_CALL_END` event is NEVER forwarded downstream on any
 * non-allow outcome — the frontend can only execute a tool it received
 * `TOOL_CALL_END` for, so an absent `TOOL_CALL_END` is the proof the tool was
 * not allowed to run.
 */
import { EventType, type BaseEvent } from "@ag-ui/client";
import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { ApprovalPoller, type ApprovalPollerOptions } from "@openbox-ai/openbox-sdk-ts/approvals";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import {
  APPROVAL_SCENARIOS,
  buildConformanceRuntime,
  FakeCore
} from "@openbox-ai/openbox-sdk-ts/conformance";
import { describe, expect, it, type Mock } from "vitest";

import { GOVERNANCE_BLOCKED_ERROR_CODE } from "../../src/copilotkit/governance-blocked-error.js";
import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "../unit/copilotkit/test-utils.js";

const TOOL_CALL_ID = "call-enforce-1";
const TOOL_NAME = "sendPayment";
const CONFORMANCE_API_URL = "https://core.test";
const CONFORMANCE_API_KEY = "obx_test_conformance";

function scriptedToolCallEvents(): BaseEvent[] {
  return [
    { toolCallId: TOOL_CALL_ID, toolCallName: TOOL_NAME, type: EventType.TOOL_CALL_START } as BaseEvent,
    { delta: '{"amount":100}', toolCallId: TOOL_CALL_ID, type: EventType.TOOL_CALL_ARGS } as BaseEvent,
    { toolCallId: TOOL_CALL_ID, type: EventType.TOOL_CALL_END } as BaseEvent,
    { type: EventType.RUN_FINISHED } as BaseEvent
  ];
}

/**
 * A `CoreAdapter` wired with a REAL `ApprovalPoller` hitting the SAME
 * `FakeCore` instance `buildConformanceRuntime` uses for `client.evaluate` —
 * two separate `OpenBoxClient` instances, one shared fake backend, so both
 * the evaluate call and the approval polls land in `fakeCore`'s captured
 * requests/queues. Fast interval/backoff keeps every test near-instant.
 */
function buildPollingAdapter(fakeCore: FakeCore, pollerOptions: ApprovalPollerOptions = {}): CoreAdapter {
  const client = new OpenBoxClient(CONFORMANCE_API_URL, CONFORMANCE_API_KEY, {
    fetchImpl: fakeCore.fetchImpl
  });
  const poller = new ApprovalPoller(client, {
    backoffMultiplier: 1,
    maxWaitMs: 2000,
    pollIntervalMs: 1,
    ...pollerOptions
  });
  return new CoreAdapter({ approvalPoller: poller });
}

function findBlockedFrame(
  events: BaseEvent[]
): (BaseEvent & { code: string; correlationId: string }) | undefined {
  return events.find(
    e =>
      e.type === EventType.RUN_ERROR &&
      (e as { code?: string }).code === GOVERNANCE_BLOCKED_ERROR_CODE
  ) as (BaseEvent & { code: string; correlationId: string }) | undefined;
}

function hasToolCallEnd(events: BaseEvent[]): boolean {
  return events.some(e => e.type === EventType.TOOL_CALL_END);
}

async function runEnforcedToolCall(
  runtime: ReturnType<typeof buildConformanceRuntime>
): Promise<{ events: BaseEvent[]; logger: { warn: Mock } }> {
  const { controller, logger } = buildController({ runtime });
  const middleware = createOpenBoxMiddleware(controller, {
    enforceApprovals: true,
    frontendToolNames: [TOOL_NAME]
  });
  const events = await collectEvents(
    middleware.run(buildRunAgentInput(), new ScriptedAgent({ events: scriptedToolCallEvents() }))
  );
  return { events, logger };
}

describe("frontend enforce gate — real approval waiting via evaluateLifecycle (B2)", () => {
  it("approve: waitForDecision resolves allow-shaped -- proceeds, no block frame, TOOL_CALL_END forwarded", async () => {
    const scenario = APPROVAL_SCENARIOS.find(s => s.name === "approved-after-one-pending-poll")!;
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map(body => ({ body })));
    const runtime = buildConformanceRuntime(fakeCore, {
      adapter: buildPollingAdapter(fakeCore)
    });

    const { events } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeUndefined();
    expect(hasToolCallEnd(events)).toBe(true);
    // Two pending polls scripted (require_approval, then allow) -- proves the
    // gate genuinely waited on `waitForDecision` rather than resolving on the
    // first (still-pending) response.
    expect(fakeCore.approvalRequests).toHaveLength(2);
  });

  it("reject: waitForDecision throws ApprovalRejectedError -- governance_blocked frame, tool NOT allowed", async () => {
    const scenario = APPROVAL_SCENARIOS.find(s => s.name === "rejected")!;
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map(body => ({ body })));
    const runtime = buildConformanceRuntime(fakeCore, {
      adapter: buildPollingAdapter(fakeCore)
    });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "approval_rejected" })
    );
  });

  it("expire: waitForDecision throws ApprovalExpiredError -- governance_blocked frame, distinct reason from reject", async () => {
    const scenario = APPROVAL_SCENARIOS.find(s => s.name === "expired")!;
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: scenario.evaluateResponse })
      .queueApproval(...scenario.pollResponses.map(body => ({ body })));
    const runtime = buildConformanceRuntime(fakeCore, {
      adapter: buildPollingAdapter(fakeCore)
    });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "approval_expired" })
    );
  });

  it("timeout: Core unreachable on every poll -- ApprovalTimeoutError -- governance_blocked frame, distinct from reject/expire", async () => {
    const fakeCore = new FakeCore()
      .queueEvaluate({ body: { approval_id: "appr-timeout", verdict: "require_approval" } })
      .failAllApprovals();
    const runtime = buildConformanceRuntime(fakeCore, {
      adapter: buildPollingAdapter(fakeCore, { maxConsecutiveFailures: 2 })
    });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "approval_timeout" })
    );
  });

  it("missing poller (HITL disabled): REQUIRE_APPROVAL fails safe rejected without ever polling -- never allowed", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ body: { verdict: "require_approval" } });
    // No poller wired -- matches `buildBaseRuntime` when `hitlEnabled: false`.
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(fakeCore.approvalRequests).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "approval_rejected" })
    );
  });
});

describe("CONSTRAIN verdict at the enforcement boundary (D5)", () => {
  it("evaluateLifecycle returns CONSTRAIN normally -- gate raises CopilotKitUnsupportedVerdictError -- explicit failure, never a silent allow", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ body: { verdict: "constrain" } });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unsupported_verdict" })
    );
  });
});

describe("BLOCK/HALT regression through the new evaluateLifecycle path", () => {
  it("BLOCK -- governance_blocked frame, tool NOT allowed", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      body: { reason: "policy denied", verdict: "block" }
    });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "blocked" }));
  });

  it("HALT -- governance_blocked frame, tool NOT allowed", async () => {
    const fakeCore = new FakeCore().queueEvaluate({
      body: { reason: "emergency stop", verdict: "halt" }
    });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "halt" }));
  });
});

describe("a gate refusal closes the run", () => {
  it.each([
    ["block", "policy denied"],
    ["halt", "emergency stop"]
  ])("%s -- the refused activity is closed as failed, then WorkflowFailed, with no WorkflowCompleted", async (verdict, reason) => {
    const fakeCore = new FakeCore().queueEvaluate({ body: { reason, verdict } });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });
    const { controller, evaluateMock } = buildController({ runtime });
    const middleware = createOpenBoxMiddleware(controller, {
      enforceApprovals: true,
      frontendToolNames: [TOOL_NAME]
    });

    await collectEvents(
      middleware.run(buildRunAgentInput(), new ScriptedAgent({ events: scriptedToolCallEvents() }))
    );

    const sent = evaluateMock.mock.calls.map(call => call[0] as Record<string, unknown>);
    const types = sent.map(p => p.event_type);
    expect(types.slice(-2)).toEqual(["ActivityCompleted", "WorkflowFailed"]);
    expect(types).not.toContain("WorkflowCompleted");
    const completed = sent.find(p => p.event_type === "ActivityCompleted");
    expect(completed?.activity_id).toBe(TOOL_CALL_ID);
    expect(completed?.status).toBe("failed");
    expect(sent.filter(p => p.event_type === "WorkflowFailed")).toHaveLength(1);
  });
});

describe("auth/API errors fail closed -- never converted to allow", () => {
  it("evaluate() rejects with 401 (GovernanceAPIError, fail-closed auth) -- governance_blocked frame, tool NOT allowed", async () => {
    const fakeCore = new FakeCore().queueEvaluate({ body: {}, status: 401 });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });

    const { events, logger } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeDefined();
    expect(hasToolCallEnd(events)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "evaluation_error" })
    );
  });

  it("evaluate() network failure under fail_open still never bypasses THIS gate's own fail-closed contract", async () => {
    // The base client's OWN outage policy is orthogonal to this gate: under
    // `fail_open` (the default `OpenBoxConfig`/client policy), a network
    // failure resolves to a fallback ALLOW `EvaluationResult` rather than
    // throwing (base SDK's own documented behavior, not this gate's to
    // override). `evaluateLifecycle` reads that ALLOW verdict like any other
    // and proceeds -- proving the gate does not ADD its own incorrect
    // fail-closed override on top of an explicit base-level ALLOW.
    const fakeCore = new FakeCore().queueEvaluate({ networkError: "core unreachable" });
    const runtime = buildConformanceRuntime(fakeCore, { adapter: new CoreAdapter() });

    const { events } = await runEnforcedToolCall(runtime);

    expect(findBlockedFrame(events)).toBeUndefined();
    expect(hasToolCallEnd(events)).toBe(true);
  });
});

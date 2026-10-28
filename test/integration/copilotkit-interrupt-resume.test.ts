import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { createOpenBoxMiddleware } from "../../src/copilotkit/openbox-middleware.js";
import { WorkflowEventType } from "../../src/types/workflow-event-type.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents,
  type BuiltController
} from "../unit/copilotkit/test-utils.js";

/**
 * Phase 4 (fixes B3/RT-F5/RT-F9/RT-F11). REPLACES
 * `test/integration/copilotkit-interrupt-current-behavior.test.ts` (deleted
 * — its "current 0.3.0 behavior (defect B3, frozen)" assertions are
 * inverted below against the SAME phase-1 fixtures) rather than converting
 * it in place, so there is exactly one authoritative interrupt/resume
 * integration suite instead of a stale "frozen defect" file living
 * alongside the corrected one.
 */

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/interrupt");

interface EventsFixture {
  events: BaseEvent[];
}

interface ResumeFixture {
  events: BaseEvent[];
  runInput: Partial<RunAgentInput>;
}

function loadEventsFixture(name: string): EventsFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as EventsFixture;
}

function loadResumeFixture(name: string): ResumeFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as ResumeFixture;
}

/** Run one scripted event sequence to completion against `controller` and return every `evaluate()` payload seen so far (cumulative across prior calls on the SAME controller — needed for the resume tests). */
async function runEvents(
  controller: BuiltController["controller"],
  events: BaseEvent[],
  inputOverride: Partial<RunAgentInput> = {}
): Promise<void> {
  const middleware = createOpenBoxMiddleware(controller, { frontendToolNames: [] });
  const agent = new ScriptedAgent({ events });
  await collectEvents(middleware.run(buildRunAgentInput(inputOverride), agent));
}

function payloadsOf(evaluateMock: BuiltController["evaluateMock"]): Record<string, unknown>[] {
  return evaluateMock.mock.calls.map(call => call[0] as Record<string, unknown>);
}

function byEventType(
  payloads: Record<string, unknown>[],
  type: string
): Record<string, unknown>[] {
  return payloads.filter(p => p["event_type"] === type);
}

describe("interrupt handling — Phase 4 corrected behavior (fixes B3)", () => {
  it("BuiltInAgent interrupt: emits copilotkit_interrupt, keeps the activity pending, emits NO WorkflowCompleted", async () => {
    const { controller, evaluateMock } = buildController();
    const fixture = loadEventsFixture("run-finished-interrupt");

    await runEvents(controller, fixture.events, { runId: "run-1", threadId: "thread-1" });

    const payloads = payloadsOf(evaluateMock);

    // INVERTS the frozen B3 assertion: the suspended tool must NEVER be
    // reported as completed — zero ActivityCompleted for this run.
    expect(byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED)).toHaveLength(0);
    // ActivityStarted DID fire (TOOL_CALL_END observed it before the
    // interrupt) — only its completion is withheld.
    expect(byEventType(payloads, WorkflowEventType.ACTIVITY_STARTED)).toHaveLength(1);

    // INVERTS the frozen B3 assertion: an interrupted run emits 0
    // WorkflowCompleted (was 1 pre-Phase-4).
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED)).toHaveLength(0);

    const interruptSignals = byEventType(payloads, WorkflowEventType.SIGNAL_RECEIVED).filter(
      p => p["signal_name"] === "copilotkit_interrupt"
    );
    expect(interruptSignals).toHaveLength(1);
    expect(interruptSignals[0]).toMatchObject({
      interrupt_ids: ["call-approve-1"],
      reasons: ["approval_required"]
    });
  });

  it("non-BuiltInAgent interrupt (id !== toolCallId): still keeps activity pending / no WorkflowCompleted, and correlates the signal on id (RT-F5)", async () => {
    const { controller, evaluateMock } = buildController();
    const fixture = loadEventsFixture("run-finished-interrupt-non-builtin");

    await runEvents(controller, fixture.events, { runId: "run-1", threadId: "thread-1" });

    const payloads = payloadsOf(evaluateMock);

    expect(byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED)).toHaveLength(0);
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED)).toHaveLength(0);

    const interruptSignals = byEventType(payloads, WorkflowEventType.SIGNAL_RECEIVED).filter(
      p => p["signal_name"] === "copilotkit_interrupt"
    );
    expect(interruptSignals).toHaveLength(1);
    // RT-F5: correlates on the interrupt's own `id` ("int-abc"), never the
    // unrelated `toolCallId` ("call-xyz") the underlying tool call used.
    expect(interruptSignals[0]?.["interrupt_ids"]).toEqual(["int-abc"]);
  });

  it("success-no-outcome fixture: still yields exactly one WorkflowCompleted (RT-F11 — must not regress)", async () => {
    const { controller, evaluateMock } = buildController();
    const fixture = loadEventsFixture("run-finished-success-no-outcome");

    await runEvents(controller, fixture.events, { runId: "run-1", threadId: "thread-1" });

    const payloads = payloadsOf(evaluateMock);
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED)).toHaveLength(1);
  });
});

describe("resume handling — connects to the pending interrupt (RT-F5/RT-F9)", () => {
  it("resume run connects to the pending activity and completes it per resume.status, then follows its own outcome", async () => {
    const { controller, evaluateMock } = buildController();
    const interruptFixture = loadEventsFixture("run-finished-interrupt");
    const resumeFixture = loadResumeFixture("run-finished-resume");

    // Run 1: interrupts (persists the pending interrupt keyed on run-1).
    await runEvents(controller, interruptFixture.events, { runId: "run-1", threadId: "thread-1" });
    // Run 2: resumes it (parentRunId: run-1, forwardedProps.resume keyed on
    // the interrupt's id).
    await runEvents(controller, resumeFixture.events, resumeFixture.runInput);

    const payloads = payloadsOf(evaluateMock);
    const completedActivities = byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED);

    // The resume-correction closes out the ORIGINAL run's dangling activity
    // — attributed to run-1's own ids, status mapped from resume.status
    // ("resolved" -> "completed"), output taken from resume.payload.
    const correction = completedActivities.find(p => p["run_id"] === "run-1");
    expect(correction).toMatchObject({
      activity_id: "call-approve-1",
      status: "completed",
      workflow_id: "thread-1"
    });
    expect(correction?.["activity_output"]).toEqual({ approved: true });

    // The resumed run's OWN TOOL_CALL_RESULT also completes its own
    // (separately observed) activity under run-2 — untouched pre-existing
    // behavior, not a Phase 4 concern, but confirms no double-counting bug
    // collapsed the two into one.
    const ownCompletion = completedActivities.find(p => p["run_id"] === "run-2");
    expect(ownCompletion).toMatchObject({ activity_id: "call-approve-1", status: "completed" });

    // The resumed run's own outcome ({type:"success"}) still completes
    // normally.
    const completedWorkflows = byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED);
    expect(completedWorkflows.filter(p => p["run_id"] === "run-2")).toHaveLength(1);

    // Its last interrupt resolved, the interrupted run itself is closed —
    // once, after the correction that resolved it.
    const originalClose = completedWorkflows.filter(p => p["run_id"] === "run-1");
    expect(originalClose).toHaveLength(1);
    expect(originalClose[0]).toMatchObject({ activity_id: "run-1-wf", workflow_id: "thread-1" });
    expect(payloads.indexOf(originalClose[0]!)).toBeGreaterThan(payloads.indexOf(correction!));
  });

  it("keeps the interrupted run open while it still has unresolved interrupts", async () => {
    const { controller, evaluateMock } = buildController();
    const store = controller.interruptStore;
    store.save(
      "run-1",
      [
        { activityId: "interrupt-a", reason: "approval", toolName: "approve", workflowId: "thread-1" },
        { activityId: "interrupt-b", reason: "approval", toolName: "approve", workflowId: "thread-1" }
      ],
      60_000
    );
    const resumeFixture = loadResumeFixture("run-finished-resume");
    const resumeInput = {
      ...resumeFixture.runInput,
      forwardedProps: { resume: [{ interruptId: "interrupt-a", status: "resolved", payload: { ok: true } }] }
    };

    await runEvents(controller, resumeFixture.events, resumeInput);

    const payloads = payloadsOf(evaluateMock);
    const resolved = byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED).find(
      p => p["run_id"] === "run-1" && p["activity_id"] === "interrupt-a"
    );
    expect(resolved).toMatchObject({ status: "completed" });
    const runOneClosed = byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED).filter(
      p => p["run_id"] === "run-1"
    );
    expect(runOneClosed).toHaveLength(0);
    expect(store.hasPending?.("run-1")).toBe(true);
  });

  it("a cancelled resume maps to an aborted ActivityCompleted (not completed)", async () => {
    const { controller, evaluateMock } = buildController();

    await runEvents(
      controller,
      [
        { toolCallId: "call-x", toolCallName: "wireTransfer", type: EventType.TOOL_CALL_START },
        { delta: '{"amount":500}', toolCallId: "call-x", type: EventType.TOOL_CALL_ARGS },
        { toolCallId: "call-x", type: EventType.TOOL_CALL_END },
        {
          outcome: {
            interrupts: [{ id: "call-x", reason: "approval_required" }],
            type: "interrupt"
          },
          type: EventType.RUN_FINISHED
        }
      ] as unknown as BaseEvent[],
      { runId: "run-cancel-1", threadId: "thread-cancel" }
    );

    await runEvents(controller, [{ type: EventType.RUN_FINISHED } as BaseEvent], {
      forwardedProps: { resume: [{ interruptId: "call-x", status: "cancelled" }] },
      parentRunId: "run-cancel-1",
      runId: "run-cancel-2",
      threadId: "thread-cancel"
    });

    const payloads = payloadsOf(evaluateMock);
    const correction = byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED).find(
      p => p["run_id"] === "run-cancel-1"
    );
    expect(correction?.["status"]).toBe("aborted");
  });

  it("resume-with-no-matching-pending: typed WorkflowFailed, never a fabricated ActivityCompleted (RT-F9)", async () => {
    const { controller, evaluateMock } = buildController();

    await runEvents(controller, [{ type: EventType.RUN_FINISHED, outcome: { type: "success" } } as BaseEvent], {
      forwardedProps: { resume: [{ interruptId: "never-existed", status: "resolved" }] },
      parentRunId: "run-never-existed",
      runId: "run-orphan-resume",
      threadId: "thread-orphan"
    });

    const payloads = payloadsOf(evaluateMock);

    expect(byEventType(payloads, WorkflowEventType.ACTIVITY_COMPLETED)).toHaveLength(0);
    expect(byEventType(payloads, WorkflowEventType.WORKFLOW_COMPLETED)).toHaveLength(0);

    const failed = byEventType(payloads, WorkflowEventType.WORKFLOW_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ run_id: "run-orphan-resume" });
    expect((failed[0]?.["error"] as Record<string, unknown> | undefined)?.["message"]).toContain(
      "never-existed"
    );
  });

  it("take() is destructive: resuming the same interrupt twice fails the second time (RT-F9)", async () => {
    const { controller, evaluateMock } = buildController();
    const interruptFixture = loadEventsFixture("run-finished-interrupt");
    const resumeFixture = loadResumeFixture("run-finished-resume");

    await runEvents(controller, interruptFixture.events, { runId: "run-1", threadId: "thread-1" });
    await runEvents(controller, resumeFixture.events, resumeFixture.runInput);
    // A SECOND resume for the exact same (already-consumed) interrupt.
    await runEvents(controller, [{ type: EventType.RUN_FINISHED, outcome: { type: "success" } } as BaseEvent], {
      forwardedProps: { resume: [{ interruptId: "call-approve-1", status: "resolved" }] },
      parentRunId: "run-1",
      runId: "run-3",
      threadId: "thread-1"
    });

    const payloads = payloadsOf(evaluateMock);
    const failedForRun3 = byEventType(payloads, WorkflowEventType.WORKFLOW_FAILED).filter(
      p => p["run_id"] === "run-3"
    );
    expect(failedForRun3).toHaveLength(1);
  });
});

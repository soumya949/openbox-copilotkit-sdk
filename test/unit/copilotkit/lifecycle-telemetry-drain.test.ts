import { describe, expect, it, vi } from "vitest";

import { LifecycleTelemetryQueue } from "../../../src/copilotkit/lifecycle-telemetry.js";

describe("LifecycleTelemetryQueue.drainRun", () => {
  it("resolves only after the run's queued events were sent", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const evaluate = vi.fn(async (payload: { event_type: string }) => {
      await gate;
      sent.push(payload.event_type);
      return null;
    });
    const queue = new LifecycleTelemetryQueue({ client: { evaluate } as never });

    queue.enqueue({ eventType: "WorkflowStarted", isTerminal: false, payload: { event_type: "WorkflowStarted" }, runId: "run-1" });
    let drained = false;
    const drain = queue.drainRun("run-1").then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(sent).toEqual(["WorkflowStarted"]);
  });

  it("resolves immediately for a run with nothing queued", async () => {
    const queue = new LifecycleTelemetryQueue({ client: { evaluate: vi.fn() } as never });
    await expect(queue.drainRun("idle-run")).resolves.toBeUndefined();
  });
});

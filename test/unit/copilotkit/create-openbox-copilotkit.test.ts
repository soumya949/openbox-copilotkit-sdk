/**
 * `createOpenBoxCopilotKit` bundle wiring (phase 5a, deliverable 2): the
 * bundle's `serverTool()` must be a REAL, controller-bound wrapper (no
 * longer the Phase-2 identity-passthrough stub) and the bundle shape must
 * stay stable. No real network call is exercised here — `apiUrl` points at
 * an unused localhost port (fails fast with ECONNREFUSED rather than a slow
 * DNS lookup) and every call below uses the DEFAULT `telemetry` mode, which
 * never awaits its background send.
 */
import { AbstractAgent, EventType, type BaseEvent } from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { createOpenBoxCopilotKit } from "../../../src/copilotkit/create-openbox-copilotkit.js";
import { getOpenBoxRuntime } from "../../../src/copilotkit/runtime-symbol.js";
import type { OpenBoxRuntimeController } from "../../../src/copilotkit/types.js";

class IdleAgent extends AbstractAgent {
  public override run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      subscriber.next({ type: EventType.RUN_STARTED } as BaseEvent);
      subscriber.next({ type: EventType.RUN_FINISHED } as BaseEvent);
      subscriber.complete();
    });
  }

  public override clone(): AbstractAgent {
    return new IdleAgent();
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

function isClosed(client: unknown): boolean {
  return (JSON.parse(JSON.stringify(client)) as { closed: boolean }).closed;
}

const TEST_CONFIG = {
  apiKey: "obx_test_create_openbox_copilotkit",
  apiUrl: "http://localhost:1"
};

describe("createOpenBoxCopilotKit", () => {
  it("returns the 4-key bundle shape ({ openboxRuntime, serverTool, shutdown, withRuntime })", async () => {
    const bundle = await createOpenBoxCopilotKit(TEST_CONFIG);

    expect(bundle.openboxRuntime).toBeDefined();
    expect(typeof bundle.serverTool).toBe("function");
    expect(typeof bundle.shutdown).toBe("function");
    expect(typeof bundle.withRuntime).toBe("function");

    await bundle.shutdown();
  });

  it("bundle.serverTool() is a REAL wrapper (not the Phase-2 identity passthrough) -- default telemetry mode governs execute without blocking it", async () => {
    const bundle = await createOpenBoxCopilotKit(TEST_CONFIG);

    const originalExecute = async (args: { amount: number }): Promise<{ amount: number }> => args;
    const tool = { execute: originalExecute, name: "chargeCard" };
    const wrapped = bundle.serverTool(tool);

    expect(wrapped.execute).not.toBe(originalExecute);
    // No `enterRunContext` scope around this call -- default telemetry mode
    // never fails safe on a missing run correlation (unlike `enforce`); it
    // synthesizes generated ids and still runs the real tool body.
    const result = await wrapped.execute({ amount: 250 });
    expect(result).toEqual({ amount: 250 });

    await bundle.shutdown();
  });

  it("enforcement.mode: 'enforce' is honored by the bound serverTool -- a wrapped tool without run correlation fails safe (execute not run)", async () => {
    const bundle = await createOpenBoxCopilotKit({
      ...TEST_CONFIG,
      enforcement: { mode: "enforce" }
    });

    let executed = false;
    const tool = {
      execute: async (_args: { amount: number }) => {
        executed = true;
        return { ok: true };
      },
      name: "chargeCard"
    };
    const wrapped = bundle.serverTool(tool);

    // No run context bound and no `executionOptions` -- enforce mode's
    // fail-safe fires before any network call is attempted.
    await expect(wrapped.execute({ amount: 10 })).rejects.toThrow();
    expect(executed).toBe(false);

    await bundle.shutdown();
  });

  it("shutdown is idempotent", async () => {
    const bundle = await createOpenBoxCopilotKit(TEST_CONFIG);

    await expect(bundle.shutdown()).resolves.toBeUndefined();
    await expect(bundle.shutdown()).resolves.toBeUndefined();
  });

  it("withRuntime shares the bundle's controller, so serverTool() and the middleware share run correlation", async () => {
    const bundle = await createOpenBoxCopilotKit(TEST_CONFIG);

    const { runtime, shutdown } = await bundle.withRuntime(
      { agents: { default: new IdleAgent() } },
      { defaults: { agentId: "support" } }
    );
    const controller = getOpenBoxRuntime<OpenBoxRuntimeController>(runtime);

    expect(controller?.runtime).toBe(bundle.openboxRuntime);
    expect(controller?.defaults).toEqual({ agentId: "support" });

    await shutdown();
    expect(isClosed(bundle.openboxRuntime.client)).toBe(false);
    await bundle.shutdown();
    expect(isClosed(bundle.openboxRuntime.client)).toBe(true);
  });

  it("withRuntime with different connection settings gets its own controller and says so", async () => {
    const warn = vi.fn();
    const bundle = await createOpenBoxCopilotKit({ ...TEST_CONFIG, logger: { warn } });

    const { runtime, shutdown } = await bundle.withRuntime(
      { agents: { default: new IdleAgent() } },
      { apiKey: "obx_test_other_agent" }
    );
    const controller = getOpenBoxRuntime<OpenBoxRuntimeController>(runtime);

    expect(controller?.runtime).not.toBe(bundle.openboxRuntime);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "with_runtime_separate_controller" }));

    await shutdown();
    await bundle.shutdown();
  });
});

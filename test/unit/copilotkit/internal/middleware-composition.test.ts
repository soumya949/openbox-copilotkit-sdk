import {
  AbstractAgent,
  EventType,
  type BaseEvent
} from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wrapCopilotRuntimeOptions } from "../../../../src/copilotkit/internal/wrap-copilot-runtime-options.js";
import { attachOpenBoxRuntime } from "../../../../src/copilotkit/runtime-symbol.js";

class FakeAgent extends AbstractAgent {
  public override run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(s => {
      s.next({ type: EventType.RUN_STARTED } as BaseEvent);
      s.complete();
    });
  }
  public override clone(): AbstractAgent {
    return new FakeAgent();
  }
  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

const CONFIG = {
  apiKey: "obx_test_middleware_composition",
  apiUrl: "http://localhost:9999"
};

function buildRuntime(controller: unknown): Record<string, unknown> {
  const runtime: Record<string, unknown> = {};
  attachOpenBoxRuntime(runtime, controller as never);
  return runtime;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("middleware composition — try/finally semantics", () => {
  it("user beforeRequestMiddleware returns a modified request and OpenBox reads from it", async () => {
    const userBefore = vi.fn(async (params: { request: Request }) => {
      return new Request(params.request.url, {
        headers: { "x-tenant-from-user": "from-user-mw" },
        method: "POST",
        body: '{"hi":"there"}',
        duplex: "half"
      } as RequestInit & { duplex?: "half" });
    });

    const tenantFromRequest = vi.fn(
      (req: Request) => req.headers.get("x-tenant-from-user") ?? undefined
    );
    const { options, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent() }, beforeRequestMiddleware: userBefore },
      CONFIG,
      { beforeRequest: { tenantFromRequest } }
    );

    const runtime = buildRuntime(controller);
    const wrapped = options.beforeRequestMiddleware!;
    await wrapped({
      path: "/api/copilotkit",
      request: new Request("http://localhost/api/copilotkit", {
        method: "POST",
        body: "{}",
        duplex: "half"
      } as RequestInit & { duplex?: "half" }),
      runtime
    } as Parameters<typeof wrapped>[0]);

    // OpenBox was invoked AFTER the user middleware, and saw the
    // user-modified request (carries x-tenant-from-user).
    expect(userBefore).toHaveBeenCalledTimes(1);
    expect(tenantFromRequest).toHaveBeenCalledTimes(1);
    const requestSeenByOpenBox = tenantFromRequest.mock.calls[0]![0];
    expect(requestSeenByOpenBox.headers.get("x-tenant-from-user")).toBe(
      "from-user-mw"
    );

    await shutdown();
  });

  it("user afterRequestMiddleware throws — OpenBox's after hook still runs and the user error re-propagates", async () => {
    const userErr = new Error("user-after-boom");
    const userAfter = vi.fn(async () => {
      throw userErr;
    });
    const outputGuardrail = vi.fn(async () => ({ classification: "allow" }));

    const { options, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent() }, afterRequestMiddleware: userAfter },
      CONFIG,
      { afterRequest: { outputGuardrail } }
    );

    const runtime = buildRuntime(controller);
    const wrapped = options.afterRequestMiddleware!;
    await expect(
      wrapped({
        messages: [{ id: "m1", role: "assistant", content: "ok" }],
        path: "/api/copilotkit",
        response: new Response("", {
          headers: { "content-type": "text/event-stream" }
        }),
        runId: "run-1",
        runtime,
        threadId: "thread-1"
      } as Parameters<typeof wrapped>[0])
    ).rejects.toBe(userErr);

    expect(outputGuardrail).toHaveBeenCalledTimes(1);

    await shutdown();
  });

  it("user beforeRequestMiddleware throws — OpenBox before still runs and user error re-propagates", async () => {
    const userErr = new Error("user-before-boom");
    const userBefore = vi.fn(async () => {
      throw userErr;
    });

    // OpenBox's before calls tenantFromRequest as its first step — spying on
    // it gives a side-effect signal that OpenBox actually ran, independent
    // of ALS visibility (enterWith doesn't propagate to the test's outer
    // continuation across the rejection boundary).
    const tenantFromRequest = vi.fn(() => "fallback");
    const { options, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent() }, beforeRequestMiddleware: userBefore },
      CONFIG,
      { beforeRequest: { tenantFromRequest } }
    );

    const runtime = buildRuntime(controller);
    const wrapped = options.beforeRequestMiddleware!;
    await expect(
      wrapped({
        path: "/api/copilotkit",
        request: new Request("http://localhost/api/copilotkit"),
        runtime
      } as Parameters<typeof wrapped>[0])
    ).rejects.toBe(userErr);

    expect(userBefore).toHaveBeenCalledTimes(1);
    expect(tenantFromRequest).toHaveBeenCalledTimes(1);

    await shutdown();
  });

  it("no user middleware supplied — OpenBox before/after still run", async () => {
    const outputGuardrail = vi.fn(async () => ({ classification: "allow" }));
    const { options, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent() } },
      CONFIG,
      { afterRequest: { outputGuardrail } }
    );

    const runtime = buildRuntime(controller);
    const before = options.beforeRequestMiddleware!;
    await before({
      path: "/api/copilotkit",
      request: new Request("http://localhost/api/copilotkit"),
      runtime
    } as Parameters<typeof before>[0]);

    const after = options.afterRequestMiddleware!;
    await after({
      messages: [{ id: "m1", role: "assistant", content: "ok" }],
      path: "/api/copilotkit",
      response: new Response(""),
      runId: "run-1",
      runtime,
      threadId: "thread-1"
    } as Parameters<typeof after>[0]);

    expect(outputGuardrail).toHaveBeenCalledTimes(1);

    await shutdown();
  });
});

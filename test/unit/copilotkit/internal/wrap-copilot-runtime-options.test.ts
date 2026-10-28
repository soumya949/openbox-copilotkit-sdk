import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  wrapCopilotRuntimeOptions,
  type CopilotRuntimeOptionsLike
} from "../../../../src/copilotkit/internal/wrap-copilot-runtime-options.js";
import { attachOpenBoxRuntime } from "../../../../src/copilotkit/runtime-symbol.js";

class FakeAgent extends AbstractAgent {
  public readonly id: string;
  public useCallCount = 0;

  public constructor(id: string) {
    super();
    this.id = id;
  }

  public override run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      subscriber.next({ type: EventType.RUN_STARTED } as BaseEvent);
      subscriber.next({ type: EventType.RUN_FINISHED } as BaseEvent);
      subscriber.complete();
    });
  }

  public override clone(): AbstractAgent {
    return new FakeAgent(this.id);
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

const CONFIG = {
  apiKey: "obx_test_wrap_basic",
  apiUrl: "http://localhost:9999"
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("wrapCopilotRuntimeOptions — agents shapes", () => {
  it("wraps a record-shape agents config and produces proxies that pass instanceof AbstractAgent", async () => {
    const options: CopilotRuntimeOptionsLike = {
      agents: { support: new FakeAgent("support"), technical: new FakeAgent("technical") }
    };

    const { options: next, shutdown } = await wrapCopilotRuntimeOptions(
      options,
      CONFIG
    );

    expect(typeof next.agents).toBe("object");
    const agents = next.agents as Record<string, AbstractAgent>;
    expect(Object.keys(agents).sort()).toEqual(["support", "technical"]);
    for (const a of Object.values(agents)) {
      expect(a).toBeInstanceOf(AbstractAgent);
    }

    await shutdown();
  });

  it("eagerly resolves a Promise-shape agents config at wrap time (returned value is a plain record, not a Promise)", async () => {
    const promiseAgents = Promise.resolve({
      support: new FakeAgent("support")
    });
    const options: CopilotRuntimeOptionsLike = { agents: promiseAgents };

    const { options: next, shutdown } = await wrapCopilotRuntimeOptions(
      options,
      CONFIG
    );

    expect(typeof next.agents).toBe("object");
    expect((next.agents as { then?: unknown }).then).toBeUndefined();
    const agents = next.agents as Record<string, AbstractAgent>;
    expect(agents.support).toBeInstanceOf(AbstractAgent);

    await shutdown();
  });

  it("wraps a factory-shape agents config so each call's result goes through proxy wrapping", async () => {
    const callMarker = vi.fn();
    const options: CopilotRuntimeOptionsLike = {
      agents: () => {
        callMarker();
        return { support: new FakeAgent("support") };
      }
    };

    const { options: next, shutdown } = await wrapCopilotRuntimeOptions(
      options,
      CONFIG
    );

    expect(typeof next.agents).toBe("function");
    const factory = next.agents as (
      ctx: { request: Request }
    ) => Promise<Record<string, AbstractAgent>>;

    const first = await factory({ request: new Request("http://localhost/") });
    const second = await factory({ request: new Request("http://localhost/") });
    expect(callMarker).toHaveBeenCalledTimes(2);
    expect(first.support).toBeInstanceOf(AbstractAgent);
    expect(second.support).toBeInstanceOf(AbstractAgent);
    // Each call yields a fresh proxy over a fresh underlying agent.
    expect(first.support).not.toBe(second.support);

    await shutdown();
  });
});

describe("wrapCopilotRuntimeOptions — controller + shutdown", () => {
  it("returns a controller with a real client + logger and an idempotent no-op shutdown", async () => {
    const { controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent("a") } },
      CONFIG
    );

    expect(controller.runtime.client).toBeDefined();
    expect(controller.logger).toBeDefined();

    await expect(shutdown()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("forwards an adopter-supplied logger and defaults onto the controller", async () => {
    const warnFn = vi.fn();
    const { controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent("a") } },
      CONFIG,
      {
        defaults: { agentId: "test", workflowType: "copilotkit", tenantId: "t" },
        logger: { warn: warnFn }
      }
    );

    expect(controller.defaults.agentId).toBe("test");
    expect(controller.defaults.tenantId).toBe("t");
    expect(controller.logger.warn).toBe(warnFn);

    await shutdown();
  });
});

describe("wrapCopilotRuntimeOptions — middleware composition (happy path)", () => {
  it("threads user-modified request through OpenBox's before middleware", async () => {
    const userBefore = vi.fn(async (params: { request: Request }) => {
      return new Request(params.request.url, {
        headers: { "x-injected": "user" },
        method: params.request.method
      });
    });

    const { options: next, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent("a") }, beforeRequestMiddleware: userBefore },
      CONFIG
    );

    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, controller);
    const wrappedBefore = next.beforeRequestMiddleware!;
    const result = await wrappedBefore({
      path: "/api/copilotkit",
      request: new Request("http://localhost/api/copilotkit", { method: "GET" }),
      runtime
    } as Parameters<typeof wrappedBefore>[0]);

    expect(userBefore).toHaveBeenCalledTimes(1);
    // User's request override is the value returned (no DID signing
    // configured, so OpenBox returns void and the user request bubbles up).
    expect(result).toBeInstanceOf(Request);
    expect((result as Request).headers.get("x-injected")).toBe("user");

    await shutdown();
  });

  it("calls user's afterRequestMiddleware before OpenBox's observation", async () => {
    const calls: string[] = [];
    const userAfter = vi.fn(async () => {
      calls.push("user");
    });

    const outputGuardrail = vi.fn(async () => {
      calls.push("openbox");
      return { classification: "allow" };
    });
    const { options: next, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new FakeAgent("a") }, afterRequestMiddleware: userAfter },
      CONFIG,
      { afterRequest: { outputGuardrail } }
    );

    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, controller);

    const wrappedAfter = next.afterRequestMiddleware!;
    await wrappedAfter({
      messages: [{ id: "m1", role: "assistant", content: "hi" }],
      path: "/api/copilotkit",
      response: new Response("", {
        headers: { "content-type": "text/event-stream" }
      }),
      runId: "run-1",
      runtime,
      threadId: "thread-1"
    } as Parameters<typeof wrappedAfter>[0]);

    expect(userAfter).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe("user");
    expect(calls).toContain("openbox");

    await shutdown();
  });
});

describe("wrapCopilotRuntimeOptions — multi-agent setup validation", () => {
  it("throws at setup when multiAgent.enabled but no parent DID is resolvable", async () => {
    const options: CopilotRuntimeOptionsLike = {
      agents: { support: new FakeAgent("support") }
    };

    await expect(
      wrapCopilotRuntimeOptions(options, CONFIG, {
        middlewareOptions: { multiAgent: { enabled: true } }
      })
    ).rejects.toThrow(/parent agent DID/i);
  });

  it("succeeds when multiAgent.enabled with an explicit parentAgentDid", async () => {
    const options: CopilotRuntimeOptionsLike = {
      agents: { support: new FakeAgent("support") }
    };

    const { shutdown } = await wrapCopilotRuntimeOptions(options, CONFIG, {
      middlewareOptions: {
        multiAgent: {
          enabled: true,
          parentAgentDid: "did:aip:22222222-2222-2222-2222-222222222222"
        }
      }
    });

    await shutdown();
  });
});

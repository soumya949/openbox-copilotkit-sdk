import { describe, expect, it, vi } from "vitest";

import {
  openBoxAfterRequest,
  type MessageLike
} from "../../../../src/copilotkit/internal/after-request.js";
import { attachOpenBoxRuntime } from "../../../../src/copilotkit/runtime-symbol.js";
import { buildController } from "../test-utils.js";

function buildRuntime() {
  const built = buildController();
  const runtime: Record<string, unknown> = {};
  attachOpenBoxRuntime(runtime, built.controller);
  return { ...built, runtime };
}

function buildParams(override: {
  messages?: MessageLike[];
  runId?: string;
  threadId?: string;
}) {
  const response = new Response("", {
    headers: { "content-type": "text/event-stream" }
  });
  return {
    messages: override.messages,
    path: "/api/copilotkit/runtime",
    response,
    runId: override.runId,
    runtime: {},
    threadId: override.threadId
  };
}

const ASSISTANT_MESSAGE: MessageLike = {
  content: "Hello from the assistant",
  id: "msg-final",
  role: "assistant"
};

describe("openBoxAfterRequest", () => {
  it("sends no governance event for the final assistant message (the answer rides on WorkflowCompleted)", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [
          { content: "Hi", id: "msg-user", role: "user" },
          ASSISTANT_MESSAGE
        ],
        runId: "run-A",
        threadId: "thread-A"
      }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("walks the messages list in reverse to give outputGuardrail the final assistant message", async () => {
    const { runtime } = buildRuntime();
    const guardrail = vi.fn().mockResolvedValue({ classification: "allow" });
    const fn = openBoxAfterRequest(runtime, { outputGuardrail: guardrail });
    const finalMessage: MessageLike = { content: "Final assistant", id: "msg-f", role: "assistant" };

    await fn({
      ...buildParams({
        messages: [
          { content: "Earlier assistant", id: "msg-a", role: "assistant" },
          { content: "User reply", id: "msg-u", role: "user" },
          finalMessage
        ],
        runId: "run-C",
        threadId: "thread-C"
      }),
      runtime
    });

    expect(guardrail).toHaveBeenCalledWith(finalMessage);
  });

  it("is a no-op when there is no assistant message in the messages list", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [{ content: "user only", id: "msg-u", role: "user" }],
        runId: "run-D",
        threadId: "thread-D"
      }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("is a no-op when messages is missing or empty", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({ ...buildParams({ runId: "r", threadId: "t" }), runtime });
    await fn({
      ...buildParams({ messages: [], runId: "r", threadId: "t" }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("skips emission when threadId or runId is missing (AG-UI middleware path owns this signal)", async () => {
    const { evaluateMock, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({ messages: [ASSISTANT_MESSAGE], threadId: "t" }),
      runtime
    });
    await fn({
      ...buildParams({ messages: [ASSISTANT_MESSAGE], runId: "r" }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("invokes outputGuardrail and records the verdict (does NOT throw into the response path)", async () => {
    const { runtime } = buildRuntime();
    const guardrail = vi.fn().mockResolvedValue({
      classification: "block",
      reason: "policy violation"
    });
    const fn = openBoxAfterRequest(runtime, { outputGuardrail: guardrail });

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-G",
          threadId: "thread-G"
        }),
        runtime
      })
    ).resolves.toBeUndefined();

    expect(guardrail).toHaveBeenCalledWith(ASSISTANT_MESSAGE);
  });

  it("does not call outputGuardrail when none is configured", async () => {
    const { runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-H",
        threadId: "thread-H"
      }),
      runtime
    });
    // No throw, no extra side effects to assert beyond the resolved promise.
  });

  it("swallows an outputGuardrail throw without propagating into v2", async () => {
    const { logger, runtime } = buildRuntime();
    const fn = openBoxAfterRequest(runtime, {
      outputGuardrail: () => {
        throw new Error("guardrail boom");
      }
    });

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-I",
          threadId: "thread-I"
        }),
        runtime
      })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it("swallows an evaluate failure (fail-open) without breaking the response path", async () => {
    const evaluateMock = vi
      .fn()
      .mockRejectedValue(new Error("upstream openbox api down"));
    const built = buildController({ evaluateMock });
    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, built.controller);
    const fn = openBoxAfterRequest(runtime);

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-J",
          threadId: "thread-J"
        }),
        runtime
      })
    ).resolves.toBeUndefined();
  });

  it("returns a no-op fn when the runtime has no OpenBox controller attached", async () => {
    const runtime = {};
    const fn = openBoxAfterRequest(runtime);

    await expect(
      fn({
        ...buildParams({
          messages: [ASSISTANT_MESSAGE],
          runId: "run-K",
          threadId: "thread-K"
        }),
        runtime
      })
    ).resolves.toBeUndefined();
  });
});

describe("openBoxAfterRequest — output dedup (RT-F14)", () => {
  it("sends nothing when the run already recorded its output via the AG-UI stream", async () => {
    const { controller, evaluateMock } = buildController();
    controller.runTerminalState.markOutputEmitted("run-dedup-1");
    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, controller);
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-dedup-1",
        threadId: "thread-dedup-1"
      }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("sends nothing when the run ended suspended (interrupt outcome, not finished)", async () => {
    const { controller, evaluateMock } = buildController();
    controller.runTerminalState.markInterrupted("run-dedup-2");
    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, controller);
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-dedup-2",
        threadId: "thread-dedup-2"
      }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("still runs outputGuardrail when RunTerminalState has no entry for the run, without sending an event", async () => {
    const { controller, evaluateMock } = buildController();
    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, controller);
    const guardrail = vi.fn().mockResolvedValue({ classification: "allow" });
    const fn = openBoxAfterRequest(runtime, { outputGuardrail: guardrail });

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-dedup-3",
        threadId: "thread-dedup-3"
      }),
      runtime
    });

    expect(guardrail).toHaveBeenCalledWith(ASSISTANT_MESSAGE);
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("clears the RunTerminalState entry after reading it (last consumer owns cleanup — bounds memory)", async () => {
    const { controller, evaluateMock } = buildController();
    controller.runTerminalState.markOutputEmitted("run-dedup-4");
    const runtime: Record<string, unknown> = {};
    attachOpenBoxRuntime(runtime, controller);
    const fn = openBoxAfterRequest(runtime);

    await fn({
      ...buildParams({
        messages: [ASSISTANT_MESSAGE],
        runId: "run-dedup-4",
        threadId: "thread-dedup-4"
      }),
      runtime
    });

    expect(evaluateMock).not.toHaveBeenCalled();
    expect(controller.runTerminalState.get("run-dedup-4")).toEqual({
      interrupted: false,
      outputEmitted: false
    });
  });
});

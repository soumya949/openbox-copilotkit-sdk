import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachOpenRouterProvenance,
  extractGenerationId,
  isModelHonored,
  isOpenRouterCall,
  provenanceAttributes,
  recordFromResponse
} from "../../../src/copilotkit/internal/openrouter-provenance.js";

import { buildController } from "./test-utils.js";

const COMPLETION = {
  choices: [{ finish_reason: "stop", message: { content: "Example Domain", role: "assistant" } }],
  id: "gen-123",
  model: "openai/gpt-4o-mini",
  provider: "OpenAI",
  usage: { completion_tokens: 7, cost: 0.00012, prompt_tokens: 40 }
};

const GENERATION_RECORD = {
  data: {
    data_region: "us",
    finish_reason: "stop",
    latency: 812,
    model: "openai/gpt-4o-mini",
    provider_name: "OpenAI",
    provider_responses: [{ latency: 790, provider_name: "OpenAI", status: 200 }],
    tokens_completion: 7,
    tokens_prompt: 40,
    total_cost: 0.00012
  }
};

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status: 200 });
}

/** A fetch double answering OpenRouter's completion and generation routes. */
function stubOpenRouter(): ReturnType<typeof vi.fn> {
  const stub = vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openrouter.ai/api/v1/generation")) {
      return Promise.resolve(json(GENERATION_RECORD));
    }
    return Promise.resolve(json(COMPLETION, { "x-generation-id": "gen-123" }));
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

const REQUEST_INIT: RequestInit = {
  body: JSON.stringify({ messages: [{ content: "Hi", role: "user" }], model: "openai/gpt-4o-mini" }),
  headers: { authorization: "Bearer sk-or-test", "content-type": "application/json" },
  method: "POST"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenRouter provenance helpers", () => {
  it("recognises OpenRouter model calls, never the generation lookup", () => {
    expect(isOpenRouterCall("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
    expect(isOpenRouterCall("https://openrouter.ai/api/v1/generation?id=gen-1")).toBe(false);
    expect(isOpenRouterCall("https://api.openai.com/v1/chat/completions")).toBe(false);
  });

  it("extracts the generation id from a JSON body and from an SSE stream", () => {
    expect(extractGenerationId(JSON.stringify(COMPLETION))).toBe("gen-123");
    const sse = `data: ${JSON.stringify({ id: "gen-456", choices: [] })}\n\ndata: [DONE]\n`;
    expect(extractGenerationId(sse)).toBe("gen-456");
  });

  it("builds a record from a streamed response when the generation record is late", () => {
    const sse = [
      `data: ${JSON.stringify({ id: "gen-9", model: "openai/gpt-4o-mini", provider: "OpenAI", choices: [] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { cost: 0.5, prompt_tokens: 3 } })}`,
      "data: [DONE]"
    ].join("\n");
    const record = recordFromResponse("gen-9", sse, null, "openai/gpt-4o-mini");
    expect(record).toMatchObject({ finishReason: "stop", modelHonored: true, provider: "OpenAI", totalCost: 0.5 });
    expect(provenanceAttributes(record!)).toMatchObject({
      "gen_ai.generation.id": "gen-9",
      "gen_ai.response.model": "openai/gpt-4o-mini",
      "gen_ai.upstream.provider": "OpenAI",
      "gen_ai.usage.total_cost": 0.5,
      "openbox.model.honored": true
    });
  });

  it("compares models by base id and treats auto-routing as no promise", () => {
    expect(isModelHonored("openai/gpt-4o-mini", "openai/gpt-4o-mini:floor")).toBe(true);
    expect(isModelHonored("openai/gpt-4o", "openai/gpt-4o-mini")).toBe(false);
    expect(isModelHonored("openai/gpt-4o", "openrouter/auto")).toBeNull();
  });
});

describe("attachOpenRouterProvenance", () => {
  it("reports an OpenRouter call in a governed run as an llm_call activity with provenance", async () => {
    stubOpenRouter();
    const { controller, evaluateMock } = buildController();
    const provenance = attachOpenRouterProvenance(controller);

    const response = await controller.runContext.enterRunContext({ runId: "run-1", workflowId: "thread-1" }, () =>
      fetch("https://openrouter.ai/api/v1/chat/completions", REQUEST_INIT)
    );
    // The caller still gets the full, unconsumed body.
    expect(await response.json()).toEqual(COMPLETION);

    await provenance.drainRun("run-1");
    await controller.telemetryQueue.flush();
    provenance.detach();

    const sent = evaluateMock.mock.calls.map(call => call[0] as Record<string, unknown>);
    expect(sent.map(p => [p.event_type, p.hook_trigger === true])).toEqual([
      ["ActivityStarted", false],
      ["ActivityStarted", true],
      ["ActivityStarted", true],
      ["ActivityCompleted", false]
    ]);
    for (const payload of sent) {
      expect(payload).toMatchObject({ activity_type: "llm_call", run_id: "run-1", workflow_id: "thread-1" });
    }
    const started = (sent[1]!.spans as Record<string, unknown>[])[0]!;
    expect(started).toMatchObject({ end_time: null, hook_type: "http_request", stage: "started" });
    const [httpCompleted, provenanceSpan] = sent[2]!.spans as Record<string, unknown>[];
    expect(httpCompleted).toMatchObject({ hook_type: "http_request", http_status_code: 200, stage: "completed" });
    expect(provenanceSpan).toMatchObject({ hook_type: "llm_provenance", stage: "completed" });
    expect(provenanceSpan!.attributes).toMatchObject({
      "gen_ai.generation.id": "gen-123",
      "gen_ai.upstream.data_region": "us",
      "gen_ai.upstream.provider": "OpenAI",
      "gen_ai.usage.tokens_prompt": 40,
      "openbox.model.honored": true
    });
    expect(sent[3]).toMatchObject({
      activity_output: { generation_id: "gen-123", model: "openai/gpt-4o-mini", provider: "OpenAI" },
      status: "completed"
    });
  });

  it("does not report OpenRouter calls made outside a governed run", async () => {
    stubOpenRouter();
    const { controller, evaluateMock } = buildController();
    const provenance = attachOpenRouterProvenance(controller);

    await fetch("https://openrouter.ai/api/v1/chat/completions", REQUEST_INIT);
    await controller.telemetryQueue.flush();
    provenance.detach();

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("is off when OPENBOX_OPENROUTER_PROVENANCE=false", async () => {
    vi.stubEnv("OPENBOX_OPENROUTER_PROVENANCE", "false");
    const stub = stubOpenRouter();
    const { controller, evaluateMock } = buildController();
    const provenance = attachOpenRouterProvenance(controller);

    expect(globalThis.fetch).toBe(stub);
    await controller.runContext.enterRunContext({ runId: "run-1", workflowId: "thread-1" }, () =>
      fetch("https://openrouter.ai/api/v1/chat/completions", REQUEST_INIT)
    );
    await controller.telemetryQueue.flush();
    provenance.detach();

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it("restores the original fetch on detach", () => {
    const stub = stubOpenRouter();
    const { controller } = buildController();
    const provenance = attachOpenRouterProvenance(controller);
    expect(globalThis.fetch).not.toBe(stub);
    provenance.detach();
    expect(globalThis.fetch).toBe(stub);
  });
});

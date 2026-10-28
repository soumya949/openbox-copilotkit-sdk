/**
 * OpenRouter routing provenance — which provider actually served each model
 * call made inside a governed run, and what it cost.
 *
 * CopilotKit's AG-UI stream never shows the model's HTTP traffic, so each
 * OpenRouter completion made while a governed run is active is reported as an
 * `llm_call` activity of that run:
 *
 *   ActivityStarted(llm_call) -> http_request span (started) -> the call ->
 *   http_request span (completed) -> llm_provenance span -> ActivityCompleted
 *
 * The `llm_provenance` span carries `gen_ai.generation.id` plus the
 * `gen_ai.*` / `openbox.*` attributes of `openbox-openrouter-sdk-ts`
 * (`src/provenance.ts`) and `openbox-sdk-python` 1.5.0, so every SDK feeds the
 * same dashboard panel. Its values come from OpenRouter's generation record
 * (`GET /api/v1/generation?id=`) when that arrives within a fixed budget after
 * the call, otherwise from the completion response itself. The lookup reuses
 * the bearer key the model call was sent with.
 *
 * The caller's response is never consumed: a streamed body is teed and the
 * caller reads its own branch. Everything after the call happens in the
 * background and never throws into the caller. A run's closing event waits
 * (bounded) for that run's pending provenance, since Core drops spans that
 * arrive after a session closes. Disable with OPENBOX_OPENROUTER_PROVENANCE=false.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { OpenBoxCopilotKitEmitter } from "../openbox-emitter.js";
import type { OpenBoxRuntimeController } from "../types.js";

const OPENROUTER_HOST = "openrouter.ai";
const GENERATION_PATH = "/api/v1/generation";
const LLM_ACTIVITY_TYPE = "llm_call";
const TOOL_ORIGIN = "openrouter";
/** Hard cap on one generation-record lookup, counted from the end of the model call. */
export const LOOKUP_BUDGET_MS = 12_000;
/** A run's closing event waits this long for its pending provenance. */
export const DRAIN_TIMEOUT_MS = LOOKUP_BUDGET_MS + 5_000;
const BACKOFF_MS = [500, 1_000, 2_000, 3_000, 4_000];
const ATTEMPT_TIMEOUT_MS = 4_000;
const MAX_CAPTURED_BODY_CHARS = 2_000_000;
/** How long an llm_call report waits for its run's WorkflowStarted. */
const START_WAIT_MS = 5_000;
const GENERATION_ID = /"id"\s*:\s*"(gen-[^"]+)"/;

export interface ProviderAttempt {
  provider?: string;
  status?: number | string;
  error?: string;
  latencyMs?: number;
}

export interface RequestedRouting {
  only?: string[];
  order?: string[];
  allowFallbacks?: boolean;
  models?: string[];
}

/** The normalized provenance of one model call. */
export interface RoutingProvenance {
  generationId: string;
  provider: string | null;
  model: string | null;
  dataRegion: string | null;
  totalCost: number | null;
  upstreamCost: number | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  isByok: boolean | null;
  attempts: ProviderAttempt[];
  requested: RequestedRouting | null;
  honored: boolean | null;
  requestedModel: string | null;
  modelHonored: boolean | null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Whether `url` is an OpenRouter model call (never the generation lookup itself). */
export function isOpenRouterCall(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === OPENROUTER_HOST && !parsed.pathname.startsWith(GENERATION_PATH);
  } catch {
    return false;
  }
}

/** Routing constraints the request itself carried (`provider.only/order/allow_fallbacks`, `models`). */
export function readRequestedRouting(request: unknown): RequestedRouting | null {
  const body = asRecord(request);
  if (!body) return null;
  const routing: RequestedRouting = {};
  const provider = asRecord(body["provider"]);
  if (provider) {
    if (Array.isArray(provider["only"])) routing.only = provider["only"].map(String);
    if (Array.isArray(provider["order"])) routing.order = provider["order"].map(String);
    if (typeof provider["allow_fallbacks"] === "boolean") routing.allowFallbacks = provider["allow_fallbacks"];
  }
  if (Array.isArray(body["models"])) routing.models = body["models"].map(String);
  return Object.keys(routing).length > 0 ? routing : null;
}

function sameProvider(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Only `provider.only` is a hard constraint; `null` when nothing was constrained. */
export function isRoutingHonored(provider: string | null, requested: RequestedRouting | null): boolean | null {
  if (!requested?.only?.length || provider === null) return null;
  return requested.only.some(allowed => sameProvider(allowed, provider));
}

function sameModel(a: string, b: string): boolean {
  const base = (id: string) => id.trim().toLowerCase().split(":")[0];
  return base(a) === base(b);
}

/** Did the model that ran match the one asked for (or one of its `models` fallbacks)? */
export function isModelHonored(
  served: string | null,
  requested: string | null,
  fallbacks?: string[] | null
): boolean | null {
  if (requested === null || requested.trim() === "") return null;
  if (requested.trim().toLowerCase().endsWith("/auto")) return null;
  if (served === null) return null;
  if (sameModel(served, requested)) return true;
  return (fallbacks ?? []).some(candidate => sameModel(candidate, served));
}

/** OpenRouter's generation record, normalized; tolerates omitted fields. */
export function normalizeGenerationRecord(
  generationId: string,
  raw: unknown,
  requested: RequestedRouting | null,
  requestedModel: string | null
): RoutingProvenance {
  const root = asRecord(raw) ?? {};
  const record = asRecord(root["data"]) ?? root;
  const attempts: ProviderAttempt[] = [];
  const responses = record["provider_responses"];
  if (Array.isArray(responses)) {
    for (const entry of responses) {
      const e = asRecord(entry);
      if (!e) continue;
      const attempt: ProviderAttempt = {};
      const provider = asString(e["provider_name"]) ?? asString(e["provider"]);
      const status = asNumber(e["status"]) ?? asString(e["status"]);
      const error = asString(e["error"]);
      const latency = asNumber(e["latency"]);
      if (provider !== null) attempt.provider = provider;
      if (status !== null) attempt.status = status;
      if (error !== null) attempt.error = error;
      if (latency !== null) attempt.latencyMs = latency;
      attempts.push(attempt);
    }
  }
  const provider = asString(record["provider_name"]);
  const model = asString(record["model"]);
  return {
    attempts,
    dataRegion: asString(record["data_region"]),
    finishReason: asString(record["finish_reason"]),
    generationId,
    honored: isRoutingHonored(provider, requested),
    isByok: typeof record["is_byok"] === "boolean" ? record["is_byok"] : null,
    latencyMs: asNumber(record["latency"]),
    model,
    modelHonored: isModelHonored(model, requestedModel, requested?.models),
    provider,
    requested,
    requestedModel,
    tokensCompletion: asNumber(record["tokens_completion"]),
    tokensPrompt: asNumber(record["tokens_prompt"]),
    totalCost: asNumber(record["total_cost"]),
    upstreamCost: asNumber(record["upstream_inference_cost"])
  };
}

/** The JSON object(s) of a completion response: one body, or SSE `data:` chunks. */
function responseChunks(body: string): Record<string, unknown>[] {
  try {
    const parsed = asRecord(JSON.parse(body));
    return parsed ? [parsed] : [];
  } catch {
    // not a single JSON body — try SSE
  }
  const chunks: Record<string, unknown>[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      const chunk = asRecord(JSON.parse(trimmed.slice(5).trim()));
      if (chunk) chunks.push(chunk);
    } catch {
      // `[DONE]` and keep-alives
    }
  }
  return chunks;
}

/** The `gen-…` id of a completion, from a JSON body or an SSE stream. */
export function extractGenerationId(body: string | null): string | null {
  if (!body) return null;
  for (const chunk of responseChunks(body)) {
    const id = asString(chunk["id"]);
    if (id?.startsWith("gen-")) return id;
  }
  return GENERATION_ID.exec(body)?.[1] ?? null;
}

/**
 * What the completion response itself says about who served it — the
 * fallback when the generation record is not published in time. Region,
 * latency and the attempt trail are only in the record, so they stay null.
 */
export function recordFromResponse(
  generationId: string,
  body: string | null,
  requested: RequestedRouting | null,
  requestedModel: string | null
): RoutingProvenance | null {
  const chunks = responseChunks(body ?? "");
  let provider: string | null = null;
  let model: string | null = null;
  let finishReason: string | null = null;
  let usage: Record<string, unknown> = {};
  for (const chunk of chunks) {
    provider = asString(chunk["provider"]) ?? provider;
    model = asString(chunk["model"]) ?? model;
    usage = asRecord(chunk["usage"]) ?? usage;
    const choices = chunk["choices"];
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        finishReason = asString(asRecord(choice)?.["finish_reason"]) ?? finishReason;
      }
    }
  }
  if (provider === null && model === null) return null;
  const costDetails = asRecord(usage["cost_details"]) ?? {};
  return {
    attempts: [],
    dataRegion: null,
    finishReason,
    generationId,
    honored: isRoutingHonored(provider, requested),
    isByok: typeof usage["is_byok"] === "boolean" ? usage["is_byok"] : null,
    latencyMs: null,
    model,
    modelHonored: isModelHonored(model, requestedModel, requested?.models),
    provider,
    requested,
    requestedModel,
    tokensCompletion: asNumber(usage["completion_tokens"]),
    tokensPrompt: asNumber(usage["prompt_tokens"]),
    totalCost: asNumber(usage["cost"]),
    upstreamCost: asNumber(costDetails["upstream_inference_cost"])
  };
}

/** The attested form: flat span attributes. Nulls are dropped, never asserted. */
export function provenanceAttributes(p: RoutingProvenance): Record<string, unknown> {
  const attrs: Record<string, unknown> = { "gen_ai.generation.id": p.generationId };
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined) attrs[key] = value;
  };
  put("gen_ai.upstream.provider", p.provider);
  put("gen_ai.response.model", p.model);
  put("gen_ai.upstream.data_region", p.dataRegion);
  put("gen_ai.usage.total_cost", p.totalCost);
  put("gen_ai.usage.upstream_cost", p.upstreamCost);
  put("gen_ai.usage.tokens_prompt", p.tokensPrompt);
  put("gen_ai.usage.tokens_completion", p.tokensCompletion);
  put("gen_ai.upstream.latency_ms", p.latencyMs);
  put("gen_ai.response.finish_reason", p.finishReason);
  put("gen_ai.upstream.is_byok", p.isByok);
  if (p.attempts.length > 0) {
    attrs["gen_ai.routing.fallback_attempts"] = p.attempts.length;
    attrs["gen_ai.routing.providers_tried"] = p.attempts
      .map(a => a.provider)
      .filter((name): name is string => name !== undefined);
    attrs["gen_ai.routing.attempts"] = p.attempts.map(a => ({
      error: a.error ?? null,
      latency_ms: a.latencyMs ?? null,
      provider: a.provider ?? null,
      status: a.status ?? null
    }));
  }
  put("openbox.routing.requested_only", p.requested?.only);
  put("openbox.routing.requested_order", p.requested?.order);
  put("openbox.routing.allow_fallbacks", p.requested?.allowFallbacks);
  put("openbox.routing.honored", p.honored);
  put("openbox.model.requested", p.requestedModel);
  put("openbox.model.honored", p.modelHonored);
  return attrs;
}

/**
 * Fetch the generation record within `deadline` (epoch ms). The record is
 * written after the response, so an early 404 is retried with backoff. Returns
 * null rather than throwing: failing to collect evidence never fails the run.
 */
export async function fetchGenerationRecord(
  fetchImpl: typeof fetch,
  generationId: string,
  apiKey: string,
  deadline: number,
  requested: RequestedRouting | null,
  requestedModel: string | null
): Promise<RoutingProvenance | null> {
  const url = `https://${OPENROUTER_HOST}${GENERATION_PATH}?id=${encodeURIComponent(generationId)}`;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(BACKOFF_MS[attempt - 1] ?? 0, deadline - Date.now());
      if (wait <= 0) return null;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    try {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        method: "GET",
        signal: controller.signal
      });
      if (response.status === 404) continue;
      if (!response.ok) return null;
      return normalizeGenerationRecord(generationId, (await response.json()), requested, requestedModel);
    } catch {
      // transient — the backoff is the retry
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function hexId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nowNs(): number {
  return Date.now() * 1_000_000;
}

/** A flat Core span (same shape the base SDKs project). */
function span(fields: {
  attributes: Record<string, unknown>;
  hookType: string;
  name: string;
  spanId: string;
  stage: "started" | "completed";
  startNs: number;
  endNs: number | null;
  traceId: string;
  extra?: Record<string, unknown>;
  error?: string | null;
}): Record<string, unknown> {
  const failed = Boolean(fields.error);
  return {
    attributes: fields.attributes,
    duration_ns: fields.endNs === null ? null : Math.max(0, fields.endNs - fields.startNs),
    end_time: fields.endNs,
    error: fields.error ?? null,
    events: [],
    hook_type: fields.hookType,
    kind: "CLIENT",
    name: fields.name,
    parent_span_id: null,
    span_id: fields.spanId,
    stage: fields.stage,
    start_time: fields.startNs,
    status:
      fields.stage === "started"
        ? { code: "UNSET", description: null }
        : { code: failed ? "ERROR" : "OK", description: fields.error ?? null },
    trace_id: fields.traceId,
    ...fields.extra
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function bearerKey(input: Parameters<typeof fetch>[0], init?: RequestInit): string | null {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const value = headers.get("authorization");
  return value?.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : null;
}

function requestBodyText(init?: RequestInit): string | null {
  return typeof init?.body === "string" ? init.body : null;
}

async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (text.length < MAX_CAPTURED_BODY_CHARS) text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** Per-controller state: the emitter that reports, each run's pending work and start gate. */
interface Registration {
  controller: OpenBoxRuntimeController;
  emitter: OpenBoxCopilotKitEmitter;
  pending: Map<string, Set<Promise<void>>>;
  started: Map<string, { promise: Promise<void>; resolve: () => void }>;
}

/** The run's start gate, opened by `markRunStarted` once WorkflowStarted is queued. */
function runStartGate(registration: Registration, runId: string): { promise: Promise<void>; resolve: () => void } {
  let gate = registration.started.get(runId);
  if (!gate) {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    gate = { promise, resolve };
    registration.started.set(runId, gate);
  }
  return gate;
}

/**
 * Resolves once the run's WorkflowStarted is queued, or after
 * `START_WAIT_MS` (a run nobody marks, e.g. outside the middleware).
 */
function whenRunStarted(registration: Registration, runId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(done => {
    timer = setTimeout(done, START_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([runStartGate(registration, runId).promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const registrations = new Set<Registration>();
let originalFetch: typeof fetch | undefined;

export function openRouterProvenanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env["OPENBOX_OPENROUTER_PROVENANCE"] ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

/** The controller whose run is active in this async context, if any. */
function activeRun(): { registration: Registration; runId: string; workflowId: string } | undefined {
  for (const registration of registrations) {
    const run = registration.controller.runContext.currentRunContext();
    if (run) return { registration, runId: run.runId, workflowId: run.workflowId };
  }
  return undefined;
}

async function governedOpenRouterFetch(
  realFetch: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
): Promise<Response> {
  const run = activeRun();
  if (!run || !isOpenRouterCall(requestUrl(input))) {
    return realFetch(input, init);
  }
  const { registration, runId, workflowId } = run;
  const { emitter } = registration;
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  const body = requestBodyText(init);
  let request: unknown = null;
  try {
    request = body ? (JSON.parse(body) as unknown) : null;
  } catch {
    request = null;
  }
  const requested = readRequestedRouting(request);
  const requestedModel = asString(asRecord(request)?.["model"]);
  const messages = asRecord(request)?.["messages"];

  const activityId = randomUUID();
  const traceId = hexId(16);
  const httpSpanId = hexId(8);
  const startedAt = Date.now();
  const startNs = nowNs();
  const httpFields = { http_method: method, http_url: url, request_body: body, request_headers: null };
  const report = { activityId, activityType: LLM_ACTIVITY_TYPE, runId, workflowId };

  // The model call can fire before the middleware handles RUN_STARTED; the
  // reports wait for the run's WorkflowStarted (the call itself never waits).
  const reported = whenRunStarted(registration, runId).then(() => {
    void emitter.emitActivityStarted({
      activityArgs: { model: requestedModel, messages: Array.isArray(messages) ? messages.length : null },
      activityId,
      frontend: false,
      runId,
      toolName: LLM_ACTIVITY_TYPE,
      toolOrigin: TOOL_ORIGIN,
      workflowId
    });
    emitter.emitHookSpans(report, [
      span({
        attributes: { "http.method": method, "http.url": url },
        endNs: null,
        extra: { ...httpFields, http_status_code: null, response_body: null, response_headers: null },
        hookType: "http_request",
        name: `HTTP ${method}`,
        spanId: httpSpanId,
        stage: "started",
        startNs,
        traceId
      })
    ]);
  });
  track(registration, runId, reported);

  let response: Response;
  try {
    response = await realFetch(input, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const endNs = nowNs();
    track(
      registration,
      runId,
      reported.then(() => {
        finishLlmCall(registration, report, {
          endNs,
          error: message,
          httpSpan: { httpFields, httpSpanId, method, startNs, traceId, url },
          provenance: null,
          startedAt,
          statusCode: null
        });
      })
    );
    throw err;
  }

  // The caller reads its own branch; the other is captured in the background.
  let callerResponse = response;
  let captured: Promise<string> = Promise.resolve("");
  if (response.body) {
    const [forCaller, forCapture] = response.body.tee();
    callerResponse = new Response(forCaller, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
    captured = readCapped(forCapture);
  }
  const headerGenerationId = response.headers.get("x-generation-id");
  const apiKey = bearerKey(input, init);

  const work = (async () => {
    let text = "";
    try {
      text = await captured;
    } catch {
      text = "";
    }
    const endedAt = Date.now();
    const endNs = nowNs();
    const generationId = asString(headerGenerationId) ?? extractGenerationId(text);
    let provenance: RoutingProvenance | null = null;
    if (generationId) {
      const fromResponse = recordFromResponse(generationId, text, requested, requestedModel);
      const fromRecord = apiKey
        ? await fetchGenerationRecord(realFetch, generationId, apiKey, endedAt + LOOKUP_BUDGET_MS, requested, requestedModel)
        : null;
      provenance = fromRecord ?? fromResponse;
    }
    await reported;
    finishLlmCall(registration, report, {
      endNs,
      error: response.ok ? null : `HTTP ${response.status}`,
      httpSpan: { httpFields, httpSpanId, method, startNs, traceId, url },
      provenance,
      responseText: text,
      startedAt,
      statusCode: response.status
    });
  })().catch((err: unknown) => {
    registration.controller.logger.warn?.({ err, note: "openbox openrouter provenance failed — skipped" });
  });
  track(registration, runId, work);
  return callerResponse;
}

function finishLlmCall(
  registration: Registration,
  report: { activityId: string; activityType: string; runId: string; workflowId: string },
  outcome: {
    endNs: number;
    error: string | null;
    httpSpan: {
      httpFields: Record<string, unknown>;
      httpSpanId: string;
      method: string;
      startNs: number;
      traceId: string;
      url: string;
    };
    provenance: RoutingProvenance | null;
    responseText?: string;
    startedAt: number;
    statusCode: number | null;
  }
): void {
  const { emitter } = registration;
  const { endNs, httpSpan } = outcome;
  // One span per hook payload: the HTTP completion, then the provenance.
  emitter.emitHookSpans(report, [
    span({
      attributes: {
        "http.method": httpSpan.method,
        "http.url": httpSpan.url,
        ...(outcome.statusCode !== null ? { "http.status_code": outcome.statusCode } : {})
      },
      endNs,
      error: outcome.error,
      extra: {
        ...httpSpan.httpFields,
        http_status_code: outcome.statusCode,
        response_body: outcome.responseText ?? null,
        response_headers: null
      },
      hookType: "http_request",
      name: `HTTP ${httpSpan.method}`,
      spanId: httpSpan.httpSpanId,
      stage: "completed",
      startNs: httpSpan.startNs,
      traceId: httpSpan.traceId
    })
  ]);
  const record = outcome.provenance;
  if (record) {
    // As in the reference SDK: OpenRouter's record of who served the call.
    emitter.emitHookSpans(report, [
      {
        ...span({
          attributes: provenanceAttributes(record),
          endNs,
          hookType: "llm_provenance",
          name: `served by ${record.provider ?? "an unreported provider"}${record.model !== null ? ` (${record.model})` : ""}`,
          spanId: hexId(8),
          stage: "completed",
          startNs: endNs,
          traceId: httpSpan.traceId
        }),
        activity_id: report.activityId,
        duration_ns: record.latencyMs !== null ? record.latencyMs * 1_000_000 : null,
        gen_ai_system: record.provider ?? "openrouter",
        semantic_type: "llm_provenance"
      }
    ]);
  }

  const p = outcome.provenance;
  void emitter.emitActivityCompleted({
    activityId: report.activityId,
    activityOutput: p
      ? {
          generation_id: p.generationId,
          model: p.model,
          provider: p.provider,
          tokens_completion: p.tokensCompletion,
          tokens_prompt: p.tokensPrompt,
          total_cost: p.totalCost
        }
      : null,
    durationMs: Math.max(0, Date.now() - outcome.startedAt),
    ...(outcome.error !== null ? { error: { message: outcome.error, name: "OpenRouterCallFailed" } } : {}),
    runId: report.runId,
    status: outcome.error === null ? "completed" : "failed",
    toolName: report.activityType,
    workflowId: report.workflowId
  });
}

function track(registration: Registration, runId: string, work: Promise<void>): void {
  let set = registration.pending.get(runId);
  if (!set) {
    set = new Set();
    registration.pending.set(runId, set);
  }
  set.add(work);
  void work.finally(() => {
    set.delete(work);
    if (set.size === 0) registration.pending.delete(runId);
  });
}

/**
 * Report OpenRouter calls made during this controller's governed runs.
 * Returns a detach function (idempotent). A no-op when disabled.
 */
export function attachOpenRouterProvenance(controller: OpenBoxRuntimeController): {
  detach: () => void;
  drainRun: (runId: string) => Promise<void>;
  markRunStarted: (runId: string) => void;
} {
  if (!openRouterProvenanceEnabled()) {
    return { detach: () => undefined, drainRun: () => Promise.resolve(), markRunStarted: () => undefined };
  }
  const registration: Registration = {
    controller,
    emitter: new OpenBoxCopilotKitEmitter(controller, undefined),
    pending: new Map(),
    started: new Map()
  };
  registrations.add(registration);
  if (originalFetch === undefined) {
    const realFetch = globalThis.fetch;
    originalFetch = realFetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      governedOpenRouterFetch(realFetch, input, init));
  }
  let detached = false;
  return {
    detach: () => {
      if (detached) return;
      detached = true;
      registrations.delete(registration);
      if (registrations.size === 0 && originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
        originalFetch = undefined;
      }
    },
    drainRun: async runId => {
      // The run is closing: anything still waiting for its start reports now.
      runStartGate(registration, runId).resolve();
      const work = [...(registration.pending.get(runId) ?? [])];
      if (work.length > 0) {
        await Promise.race([
          Promise.allSettled(work),
          new Promise(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS))
        ]);
      }
      registration.started.delete(runId);
    },
    markRunStarted: runId => {
      runStartGate(registration, runId).resolve();
    }
  };
}

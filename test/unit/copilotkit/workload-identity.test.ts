import { generateKeyPairSync } from "node:crypto";

import { EventEnvelope, EventType } from "@openbox-ai/openbox-sdk-ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildBaseRuntime } from "../../../src/copilotkit/internal/base-runtime-builder.js";
import { ChildAgentClientCache } from "../../../src/copilotkit/internal/child-agent-client-cache.js";

const CORE_URL = "https://core.example.com";
const API_KEY = "obx_test_copilotkit_workload";
const ISSUER = "https://identity.example.com/realms/openbox";
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const WORKLOAD_TOKEN = "workload-access-token";
const WORKLOAD_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
}

/** Answers Core's v3 routes and the Keycloak token endpoint; records every request. */
function stubV3Core(): Recorded[] {
  const recorded: Recorded[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    recorded.push({ headers: new Headers(init?.headers), method: init?.method ?? "GET", url });
    if (url === `${CORE_URL}/api/v3/auth/bootstrap`) {
      return Promise.resolve(
        json(200, {
          activation_version: "22222222-2222-4222-8222-222222222222",
          audience: "openbox-core",
          bootstrap_version: 3,
          client_id: "copilotkit-workload-client",
          contract_version: 3,
          identity_source: "openbox",
          issuer: ISSUER,
          kid: "copilotkit-workload-key",
          service_account_id: "11111111-1111-4111-8111-111111111111",
          token_endpoint: TOKEN_ENDPOINT
        })
      );
    }
    if (url === TOKEN_ENDPOINT) {
      return Promise.resolve(json(200, { access_token: WORKLOAD_TOKEN, expires_in: 300, token_type: "Bearer" }));
    }
    if (url === `${CORE_URL}/api/v3/governance/evaluate`) {
      return Promise.resolve(json(200, { verdict: "allow" }));
    }
    return Promise.resolve(json(404, { error: "not_found" }));
  });
  return recorded;
}

function workflowStarted(): EventEnvelope {
  return new EventEnvelope({
    eventType: EventType.WORKFLOW_STARTED,
    payload: { run_id: "run-1", workflow_id: "wf-1", workflow_type: "copilotkit" }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("v3 Keycloak workload identity", () => {
  it("resolves keycloak_workload from an explicit workloadPrivateKey", () => {
    const built = buildBaseRuntime({ apiKey: API_KEY, apiUrl: CORE_URL, workloadPrivateKey: WORKLOAD_PEM });

    expect(built.runtime.config.resolvedIdentityMethod()).toBe("keycloak_workload");
  });

  it("resolves keycloak_workload from OPENBOX_WORKLOAD_PRIVATE_KEY", () => {
    vi.stubEnv("OPENBOX_WORKLOAD_PRIVATE_KEY", WORKLOAD_PEM);

    const built = buildBaseRuntime({ apiKey: API_KEY, apiUrl: CORE_URL });

    expect(built.runtime.config.resolvedIdentityMethod()).toBe("keycloak_workload");
  });

  it("prefers OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY over the global variable", () => {
    vi.stubEnv("OPENBOX_WORKLOAD_PRIVATE_KEY", "not-a-key");
    vi.stubEnv("OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY", WORKLOAD_PEM);

    const built = buildBaseRuntime({ apiKey: API_KEY, apiUrl: CORE_URL });

    expect(built.runtime.config.resolvedWorkloadPrivateKey()).toBe(WORKLOAD_PEM);
  });

  it("sends governance traffic to Core v3 with the API key and a workload token", async () => {
    const recorded = stubV3Core();
    const built = buildBaseRuntime({ apiKey: API_KEY, apiUrl: CORE_URL, workloadPrivateKey: WORKLOAD_PEM });

    await built.runtime.client.evaluate(workflowStarted().toPayloadDict());

    const evaluate = recorded.find(request => request.url.endsWith("/governance/evaluate"));
    expect(evaluate?.url).toBe(`${CORE_URL}/api/v3/governance/evaluate`);
    expect(evaluate?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(evaluate?.headers.get("x-openbox-workload-token")).toBe(WORKLOAD_TOKEN);
    expect(evaluate?.headers.get("x-openbox-sdk-version")).toMatch(/^openbox-copilotkit-typescript-v\d+\.\d+\.\d+$/);
    expect(recorded.some(request => request.url.includes("/api/v1/"))).toBe(false);
    await built.shutdown();
  });

  it("keeps API-key-only agents on Core v1", () => {
    const built = buildBaseRuntime({ apiKey: API_KEY, apiUrl: CORE_URL });

    expect(built.runtime.config.resolvedIdentityMethod()).toBe("legacy_unsigned");
  });

  it("rejects DID and workload identity configured together", () => {
    expect(() =>
      buildBaseRuntime({
        agentDid: "did:aip:550e8400-e29b-41d4-a716-446655440000",
        agentPrivateKey: Buffer.alloc(32, 1).toString("base64"),
        apiKey: API_KEY,
        apiUrl: CORE_URL,
        workloadPrivateKey: WORKLOAD_PEM
      })
    ).toThrow();
  });
});

describe("ChildAgentClientCache", () => {
  it("closes every cached child client on close()", async () => {
    const cache = new ChildAgentClientCache();
    const close = vi.fn();
    cache.getOrCreate("did:aip:child", () => ({ close }) as never);

    await cache.close();

    expect(close).toHaveBeenCalledOnce();
  });
});

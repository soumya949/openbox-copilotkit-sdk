import { OpenBoxConfig as BaseOpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import {
  OpenBoxAuthError as BaseOpenBoxAuthError,
  OpenBoxConfigError as BaseOpenBoxConfigError,
  OpenBoxInsecureURLError as BaseOpenBoxInsecureURLError
} from "@openbox-ai/openbox-sdk-ts";

import { OpenBoxClient, type OpenBoxApiErrorPolicy } from "../client/index.js";
import {
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxInsecureURLError
} from "../types/index.js";

export const API_KEY_PATTERN = /^obx_(live|test)_[a-zA-Z0-9_]+$/;

export interface OpenBoxConfigInput {
  agentDid?: string | undefined;
  agentPrivateKey?: string | undefined;
  /**
   * v3 Keycloak workload identity: the agent's workload private key (PKCS#8
   * PEM). Env: `OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY` / `OPENBOX_WORKLOAD_PRIVATE_KEY`.
   */
  workloadPrivateKey?: string | undefined;
  /** Explicit identity method; inferred from the identity fields when unset. */
  identityMethod?: "openbox_did" | "okta_ai_agent" | "keycloak_workload" | undefined;
  /** v2 Okta AI Agent identity. With only the private key set, Core supplies the rest at bootstrap. */
  oktaAgentPrivateKey?: string | undefined;
  oktaAgentId?: string | undefined;
  oktaAgentKeyId?: string | undefined;
  oktaAgentAlgorithm?: string | undefined;
  agentId?: string | undefined;
  organizationId?: string | undefined;
  deploymentId?: string | undefined;
  agentProofAudience?: string | undefined;
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  evaluateMaxRetries?: number | undefined;
  evaluateRetryBaseDelayMs?: number | undefined;
  governanceTimeout?: number | undefined;
  hitlEnabled?: boolean | undefined;
  httpCapture?: boolean | undefined;
  instrumentDatabases?: boolean | undefined;
  instrumentFileIo?: boolean | undefined;
  maxEvaluatePayloadBytes?: number | undefined;
  onApiError?: OpenBoxApiErrorPolicy | undefined;
  sendActivityStartEvent?: boolean | undefined;
  sendStartEvent?: boolean | undefined;
  skipActivityTypes?: Iterable<string> | undefined;
  skipHitlActivityTypes?: Iterable<string> | undefined;
  skipSignals?: Iterable<string> | undefined;
  skipWorkflowTypes?: Iterable<string> | undefined;
  validate?: boolean | undefined;
}

export interface OpenBoxConfig {
  agentDid: string | undefined;
  agentPrivateKey: string | undefined;
  apiKey: string;
  apiUrl: string;
  evaluateMaxRetries: number;
  evaluateRetryBaseDelayMs: number;
  governanceTimeout: number;
  hitlEnabled: boolean;
  httpCapture: boolean;
  instrumentDatabases: boolean;
  instrumentFileIo: boolean;
  maxEvaluatePayloadBytes: number;
  onApiError: OpenBoxApiErrorPolicy;
  sendActivityStartEvent: boolean;
  sendStartEvent: boolean;
  skipActivityTypes: Set<string>;
  skipHitlActivityTypes: Set<string>;
  skipSignals: Set<string>;
  skipWorkflowTypes: Set<string>;
  validate: boolean;
}

let globalConfig: OpenBoxConfig | undefined;

export function validateApiKeyFormat(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey);
}

export function validateUrlSecurity(apiUrl: string): void {
  const url = new URL(apiUrl);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const isLocalhost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (url.protocol === "http:" && !isLocalhost) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. Use HTTPS for non-localhost URLs to protect API keys in transit.`
    );
  }
}

/**
 * @deprecated Thin translator over the base SDK's `OpenBoxConfig.resolve()`
 * (RT-F6/D3) — no second config-validation engine remains in this package.
 * The core validated fields (`apiUrl`, `apiKey`, `agentDid`,
 * `agentPrivateKey`) delegate to base for HTTPS/localhost + API-key-format +
 * DID/key validation; the CopilotKit-specific flat fields below have no base
 * equivalent (base's `OpenBoxConfig` nests `hitl`/`gate`/`instrumentation`
 * groups — see `copilotkit/internal/config-translator.ts`, the translator the
 * REAL runtime path uses) and keep their historical parsing here unchanged.
 * `parseOpenBoxConfig`/`initializeOpenBox` are not used by
 * `withOpenBoxRuntime`/`createOpenBoxCopilotKit` internally (verified — the
 * runtime path resolves config via `resolveCopilotKitBaseConfig` directly);
 * kept as a deprecated standalone helper for one release. Removed at `1.0.0`.
 */
export function parseOpenBoxConfig(
  input: OpenBoxConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): OpenBoxConfig {
  const onApiError =
    input.onApiError ?? parsePolicy(env.OPENBOX_GOVERNANCE_POLICY, "fail_open");
  const apiUrl = input.apiUrl ?? env.OPENBOX_URL;
  const agentDid = normalizeOptionalString(
    input.agentDid ?? env.OPENBOX_AGENT_DID
  );
  const agentPrivateKey = normalizeOptionalString(
    input.agentPrivateKey ?? env.OPENBOX_AGENT_PRIVATE_KEY
  );

  let resolved: BaseOpenBoxConfig;
  try {
    resolved = BaseOpenBoxConfig.resolve({
      environ: env,
      ...(apiUrl !== undefined ? { apiUrl } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(agentDid !== undefined ? { agentDid } : {}),
      ...(agentPrivateKey !== undefined ? { agentPrivateKey } : {})
    });
    // Base's own `normalized()` format-checks the DID but does not decode
    // the private key; eagerly load the identity too so a malformed key
    // throws HERE — matching this function's historical eager-validation
    // behavior (the returned `AgentIdentity` itself is discarded).
    resolved.loadIdentity();
  } catch (err) {
    throw toAdapterConfigError(err);
  }

  return {
    agentDid: resolved.agentDid ?? undefined,
    agentPrivateKey: resolved.agentPrivateKey ?? undefined,
    apiKey: resolved.apiKey,
    apiUrl: resolved.apiUrl,
    evaluateMaxRetries:
      input.evaluateMaxRetries ??
      parseInteger(env.OPENBOX_EVALUATE_MAX_RETRIES, 2),
    evaluateRetryBaseDelayMs:
      input.evaluateRetryBaseDelayMs ??
      parseInteger(env.OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS, 150),
    governanceTimeout:
      input.governanceTimeout ?? parseNumber(env.OPENBOX_GOVERNANCE_TIMEOUT, 30),
    hitlEnabled: input.hitlEnabled ?? parseBoolean(env.OPENBOX_HITL_ENABLED, true),
    httpCapture: input.httpCapture ?? parseBoolean(env.OPENBOX_HTTP_CAPTURE, true),
    instrumentDatabases:
      input.instrumentDatabases ??
      parseBoolean(env.OPENBOX_INSTRUMENT_DATABASES, true),
    instrumentFileIo:
      input.instrumentFileIo ?? parseBoolean(env.OPENBOX_INSTRUMENT_FILE_IO, false),
    maxEvaluatePayloadBytes:
      input.maxEvaluatePayloadBytes ??
      parseInteger(env.OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES, 256_000),
    onApiError,
    sendActivityStartEvent:
      input.sendActivityStartEvent ??
      parseBoolean(env.OPENBOX_SEND_ACTIVITY_START_EVENT, true),
    sendStartEvent:
      input.sendStartEvent ?? parseBoolean(env.OPENBOX_SEND_START_EVENT, true),
    skipActivityTypes:
      iterableToSet(input.skipActivityTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_ACTIVITY_TYPES, ["send_governance_event"]),
    skipHitlActivityTypes:
      iterableToSet(input.skipHitlActivityTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_HITL_ACTIVITY_TYPES, ["send_governance_event"]),
    skipSignals:
      iterableToSet(input.skipSignals) ?? parseCsvSet(env.OPENBOX_SKIP_SIGNALS),
    skipWorkflowTypes:
      iterableToSet(input.skipWorkflowTypes) ??
      parseCsvSet(env.OPENBOX_SKIP_WORKFLOW_TYPES),
    validate: input.validate ?? parseBoolean(env.OPENBOX_VALIDATE, true)
  };
}

/** @deprecated See `parseOpenBoxConfig`. Removed at `1.0.0`. */
export async function initializeOpenBox(
  input: OpenBoxConfigInput = {}
): Promise<OpenBoxConfig> {
  const config = parseOpenBoxConfig(input);

  if (config.validate) {
    const client = new OpenBoxClient({
      agentDid: config.agentDid,
      agentPrivateKey: config.agentPrivateKey,
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      timeoutSeconds: config.governanceTimeout
    });

    await client.validateApiKey();
  }

  globalConfig = config;

  return config;
}

export function getOpenBoxConfig(): OpenBoxConfig | undefined {
  return globalConfig;
}

export function setOpenBoxConfig(config: OpenBoxConfig): void {
  globalConfig = config;
}

/**
 * Base's `OpenBoxConfig.resolve()`/`.loadIdentity()` throw base's OWN error
 * classes (`@openbox-ai/openbox-sdk-ts`). Re-thrown as this package's
 * equivalent so `instanceof` checks against this package's exported error
 * classes keep working for existing callers of `parseOpenBoxConfig` (only the
 * message wording, sourced from base, changes).
 */
function toAdapterConfigError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof BaseOpenBoxInsecureURLError) {
    return new OpenBoxInsecureURLError(message);
  }

  if (error instanceof BaseOpenBoxAuthError) {
    return new OpenBoxAuthError(message);
  }

  if (error instanceof BaseOpenBoxConfigError) {
    return new OpenBoxConfigError(message);
  }

  return error instanceof Error ? error : new OpenBoxConfigError(message);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new OpenBoxConfigError(`Invalid boolean value: ${value}`);
}

function parseCsvSet(
  value: string | undefined,
  defaults: Iterable<string> = []
): Set<string> {
  if (!value) {
    return new Set(defaults);
  }

  return new Set(
    value
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new OpenBoxConfigError(`Invalid numeric value: ${value}`);
  }

  return parsed;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new OpenBoxConfigError(`Invalid integer value: ${value}`);
  }

  return parsed;
}

function parsePolicy(
  value: string | undefined,
  defaultValue: OpenBoxApiErrorPolicy
): OpenBoxApiErrorPolicy {
  if (!value) {
    return defaultValue;
  }

  if (value === "fail_open" || value === "fail_closed") {
    return value;
  }

  throw new OpenBoxConfigError(`Invalid OpenBox governance policy: ${value}`);
}

function iterableToSet(
  value: Iterable<string> | undefined
): Set<string> | undefined {
  return value ? new Set(value) : undefined;
}

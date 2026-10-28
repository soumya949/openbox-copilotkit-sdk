import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";

import type { OpenBoxConfigInput } from "../../config/openbox-config.js";
import { SDK_METADATA } from "../../sdk-metadata.js";
import type { TelemetryQueueOptions } from "../lifecycle-telemetry.js";
import type { OpenBoxLogger } from "../types.js";

import { ENV_PREFIX, resolveIntegerAlias, resolveNumberAlias } from "./config-alias-env-resolvers.js";
import {
  resolveGateConfig,
  resolveHitlConfig,
  resolveInstrumentationConfig,
  warnDeprecatedRetryFields
} from "./config-nested-group-resolvers.js";
import { warnDeprecatedOnce } from "./config-deprecation-warnings.js";
import type { OpenBoxInstrumentationOptions } from "./instrumentation.js";

export { resetConfigTranslatorDeprecationWarningsForTests } from "./config-deprecation-warnings.js";

/**
 * Full config-alias migration (phase-06 plan's "Config migration" table, the
 * authoritative spec this file implements). Translates every legacy
 * `OpenBoxConfigInput` field this SDK has ever accepted into the base
 * `OpenBoxConfig.resolve()` call plus the adapter's own telemetry-queue
 * options -- replacing `base-runtime-builder.ts`'s former PARTIAL
 * `resolveBaseConfig` (which only ever forwarded apiUrl/apiKey/agentDid/
 * agentPrivateKey/governanceTimeout/onApiError/hitlEnabled).
 *
 * Resolution order per field (highest wins): explicit `configInput` value ->
 * `OPENBOX_COPILOTKIT_<FIELD>` env -> `OPENBOX_<FIELD>` env -> a legacy
 * compat alias (only `apiUrl`'s `OPENBOX_URL` has one) -> base/adapter
 * default -- see `config-alias-env-resolvers.ts` for the shared per-field
 * resolvers and `config-nested-group-resolvers.ts` for the `hitl`/`gate`/
 * `instrumentation` nested groups. Base's own `OpenBoxConfig.resolve` already
 * performs the first three tiers itself for its OWN env-resolvable fields
 * (`apiUrl`, `apiKey`, `timeoutSeconds`, `onApiError`, `agentDid`,
 * `agentPrivateKey`, and the v2/v3 identity fields — `workloadPrivateKey`,
 * `identityMethod`, `okta*`, `agentId`, `organizationId`, `deploymentId`,
 * `agentProofAudience`) when this translator leaves them unset; every OTHER
 * field (the nested groups base does NOT env-resolve, plus the adapter-only
 * telemetry-queue bounds) gets the same three-tier resolution replicated
 * here.
 *
 * D3: no config field is ever REMOVED in `0.4.x` -- every deprecated field
 * keeps working, it just also emits a one-time (per field name, per process)
 * `logger.warn` -- see `config-deprecation-warnings.ts`.
 */

/**
 * Translate `configInput` (+ the new `instrumentation` public option) into a
 * resolved base `OpenBoxConfig`. Replaces `base-runtime-builder.ts`'s former
 * `resolveBaseConfig`.
 */
export function resolveCopilotKitBaseConfig(
  configInput: OpenBoxConfigInput,
  instrumentationOption: OpenBoxInstrumentationOptions | undefined,
  logger: OpenBoxLogger | undefined,
  env: NodeJS.ProcessEnv = process.env
): OpenBoxConfig {
  // The base SDK's own env fallback reads `OPENBOX_API_URL` (and, via
  // `envPrefix` below, `OPENBOX_COPILOTKIT_API_URL`); this SDK's documented
  // env var is `OPENBOX_URL` -- a compat alias, lowest-priority tier, kept
  // exactly as the pre-6a builder resolved it.
  const explicitApiUrl = configInput.apiUrl;
  const compatApiUrlFromEnv = env["OPENBOX_URL"];
  if (explicitApiUrl === undefined && compatApiUrlFromEnv !== undefined) {
    warnDeprecatedOnce(
      logger,
      "OPENBOX_URL",
      "deprecated_openbox_url_env",
      "the `OPENBOX_URL` environment variable is deprecated in favor of `OPENBOX_API_URL` (or `OPENBOX_COPILOTKIT_API_URL`); it continues to work."
    );
  }
  const apiUrl = explicitApiUrl ?? compatApiUrlFromEnv;

  const timeoutSeconds = resolveNumberAlias(configInput.governanceTimeout, "GOVERNANCE_TIMEOUT", env);
  if (timeoutSeconds !== undefined) {
    warnDeprecatedOnce(
      logger,
      "governanceTimeout",
      "deprecated_governance_timeout",
      "`governanceTimeout` is deprecated in favor of the base SDK's `timeoutSeconds`; it continues to work."
    );
  }

  warnDeprecatedRetryFields(configInput, logger, env);

  const hitl = resolveHitlConfig(configInput, logger, env);
  const gate = resolveGateConfig(configInput, logger, env);
  const instrumentation = resolveInstrumentationConfig(configInput, instrumentationOption, logger, env);

  return OpenBoxConfig.resolve({
    envPrefix: ENV_PREFIX,
    environ: env,
    sdkEngine: SDK_METADATA.engine,
    sdkLanguage: SDK_METADATA.language,
    sdkVersion: SDK_METADATA.version,
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(configInput.apiKey !== undefined ? { apiKey: configInput.apiKey } : {}),
    ...(configInput.agentDid !== undefined ? { agentDid: configInput.agentDid } : {}),
    ...(configInput.agentPrivateKey !== undefined
      ? { agentPrivateKey: configInput.agentPrivateKey }
      : {}),
    ...explicitIdentityFields(configInput),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(configInput.onApiError !== undefined ? { onApiError: configInput.onApiError } : {}),
    hitl,
    gate,
    instrumentation
  });
}

/** Identity fields forwarded to the base SDK, which resolves and validates the method. */
const IDENTITY_FIELDS = [
  "workloadPrivateKey",
  "identityMethod",
  "oktaAgentPrivateKey",
  "oktaAgentId",
  "oktaAgentKeyId",
  "oktaAgentAlgorithm",
  "agentId",
  "organizationId",
  "deploymentId",
  "agentProofAudience"
] as const satisfies readonly (keyof OpenBoxConfigInput)[];

/**
 * The explicitly set v2/v3 identity fields of `configInput`. Unset fields are
 * left out, so base `OpenBoxConfig.resolve()` falls back to
 * `OPENBOX_COPILOTKIT_<FIELD>` / `OPENBOX_<FIELD>` for them.
 */
type IdentityField = (typeof IDENTITY_FIELDS)[number];
type ExplicitIdentityFields = { [K in IdentityField]?: NonNullable<OpenBoxConfigInput[K]> };

function explicitIdentityFields(configInput: OpenBoxConfigInput): ExplicitIdentityFields {
  const fields: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) {
    const value = configInput[field];
    if (value !== undefined) {
      fields[field] = value;
    }
  }
  return fields;
}

/**
 * Resolve the effective telemetry-queue options: the new
 * `telemetry.maxPayloadBytes` wins when set; the deprecated
 * `maxEvaluatePayloadBytes` (bytes, envelope-total -- NOT chars, matching the
 * new option's own unit) is honored only as a fallback when the new option
 * is absent.
 */
export function resolveTelemetryQueueOptions(
  configInput: OpenBoxConfigInput,
  telemetryOption: TelemetryQueueOptions | undefined,
  logger: OpenBoxLogger | undefined,
  env: NodeJS.ProcessEnv = process.env
): TelemetryQueueOptions | undefined {
  const maxEvaluatePayloadBytesAlias = resolveIntegerAlias(
    configInput.maxEvaluatePayloadBytes,
    "MAX_EVALUATE_PAYLOAD_BYTES",
    env
  );

  if (maxEvaluatePayloadBytesAlias === undefined) {
    return telemetryOption;
  }

  warnDeprecatedOnce(
    logger,
    "maxEvaluatePayloadBytes",
    "deprecated_max_evaluate_payload_bytes",
    "`maxEvaluatePayloadBytes` is deprecated in favor of `telemetry.maxPayloadBytes` (same unit -- UTF-8 bytes, envelope-total); honored only as a fallback when the new option is not set."
  );

  if (telemetryOption?.maxPayloadBytes !== undefined) {
    return telemetryOption;
  }

  return { ...telemetryOption, maxPayloadBytes: maxEvaluatePayloadBytesAlias };
}

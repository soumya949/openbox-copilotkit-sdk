import {
  CopilotRuntime,
  type CopilotRuntimeOptions
} from "@copilotkit/runtime/v2";

import { type OpenBoxConfigInput } from "../config/openbox-config.js";

import {
  wrapCopilotRuntimeOptions,
  type CopilotRuntimeOptionsLike
} from "./internal/wrap-copilot-runtime-options.js";
import {
  attachOpenBoxRuntime,
  OPENBOX_COPILOTKIT_RUNTIME_SYMBOL
} from "./runtime-symbol.js";
import type {
  OpenBoxLogger,
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController,
  OpenBoxRuntimeDefaults
} from "./types.js";

/**
 * Combined configuration object for `withOpenBoxRuntime`. Extends
 * `OpenBoxConfigInput` with the CopilotKit-runtime-specific extras adopters
 * may need to forward into the request-scoped middleware. `logger` and
 * `defaults` are wire-level knobs reserved for advanced operators; most
 * integrations only need `apiKey`/`apiUrl`/`onApiError`/`agentDid`/
 * `agentPrivateKey` plus `middlewareOptions`.
 */
export interface WithOpenBoxRuntimeConfig extends OpenBoxConfigInput {
  defaults?: OpenBoxRuntimeDefaults;
  logger?: OpenBoxLogger;
  middlewareOptions?: OpenBoxMiddlewareOptions;
  /**
   * Perform a real `GET /api/v1/auth/validate` round-trip at setup time.
   * Default `false` — `withOpenBoxRuntime` never performs a network call at
   * construction unless this is explicitly enabled. Distinct from the base
   * config's own `validate` flag (format/shape validation only, no network).
   */
  validateApiKeyAtStartup?: boolean;
}

export interface WithOpenBoxRuntimeResult {
  runtime: CopilotRuntime;
  shutdown: () => Promise<void>;
}

const INSTANCE_FORM_MESSAGE =
  "withOpenBoxRuntime: pass CopilotRuntimeOptions (not a constructed CopilotRuntime). Example: const { runtime, shutdown } = await withOpenBoxRuntime({ agents }, openboxConfig).";

/**
 * The canonical public adopter entry point. Wraps `CopilotRuntimeOptions` with
 * OpenBox governance + telemetry and constructs the runtime in one call.
 *
 * Minimal integration shape:
 *
 *   const { runtime, shutdown } = await withOpenBoxRuntime(opts, cfg);
 *   const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
 *   process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
 *
 * Implementation detail: the controller is attached to the constructed runtime
 * via the private `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL` so the per-request
 * before/after middleware (composed inside `wrapCopilotRuntimeOptions`) can
 * resolve it at request time. The symbol is un-registered — external code
 * cannot lookup the controller.
 *
 * The returned `shutdown` is idempotent: concurrent and repeat calls reuse
 * the first invocation's promise. It resolves to an inner `Promise.resolve()`
 * (reserved for future client-side cleanup) and clears the runtime-attached
 * controller.
 */
export async function withOpenBoxRuntime(
  options: CopilotRuntimeOptions,
  config: WithOpenBoxRuntimeConfig = {}
): Promise<WithOpenBoxRuntimeResult> {
  return buildOpenBoxRuntime(options, config);
}

/**
 * `withOpenBoxRuntime`, optionally over an existing controller (a
 * `createOpenBoxCopilotKit` bundle's) — see
 * `WrapCopilotRuntimeOptionsExtras.sharedController`. Internal.
 */
export async function buildOpenBoxRuntime(
  options: CopilotRuntimeOptions,
  config: WithOpenBoxRuntimeConfig = {},
  sharedController?: OpenBoxRuntimeController
): Promise<WithOpenBoxRuntimeResult> {
  if (isCopilotRuntimeInstance(options)) {
    throw new TypeError(INSTANCE_FORM_MESSAGE);
  }

  const { defaults, logger, middlewareOptions, validateApiKeyAtStartup, ...openboxConfig } =
    config;

  const wrapped = await wrapCopilotRuntimeOptions(
    options as unknown as CopilotRuntimeOptionsLike,
    openboxConfig,
    {
      ...(defaults !== undefined ? { defaults } : {}),
      ...(logger !== undefined ? { logger } : {}),
      ...(middlewareOptions !== undefined ? { middlewareOptions } : {}),
      ...(validateApiKeyAtStartup !== undefined ? { validateApiKeyAtStartup } : {}),
      ...(sharedController !== undefined ? { sharedController } : {})
    }
  );

  const runtime = new CopilotRuntime(wrapped.options);
  attachOpenBoxRuntime<OpenBoxRuntimeController>(runtime, wrapped.controller);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        try {
          await wrapped.shutdown();
        } finally {
          delete (runtime as unknown as Record<symbol, unknown>)[
            OPENBOX_COPILOTKIT_RUNTIME_SYMBOL
          ];
        }
      })();
    }
    return shutdownPromise;
  };

  return { runtime, shutdown };
}

/**
 * `CopilotRuntime` exposes the v2 class constructor as a public export, so
 * `instanceof` is precise. A duck-type fallback would be brittle (the runtime
 * options object happens to have several of the same property names — `agents`,
 * `runner`, etc.).
 */
function isCopilotRuntimeInstance(value: unknown): boolean {
  return value instanceof CopilotRuntime;
}

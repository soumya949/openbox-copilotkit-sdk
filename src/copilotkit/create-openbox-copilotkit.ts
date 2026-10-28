import type { CopilotRuntimeOptions } from "@copilotkit/runtime/v2";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { OpenBoxConfigInput } from "../config/openbox-config.js";

import { buildBaseRuntime } from "./internal/base-runtime-builder.js";
import { attachOpenRouterProvenance } from "./internal/openrouter-provenance.js";
import type { TelemetryQueueOptions } from "./lifecycle-telemetry.js";
import { InMemoryInterruptStore } from "./internal/interrupt-store.js";
import { RunTerminalStateRegistry } from "./internal/run-terminal-state.js";
import { ServerToolOwnershipRegistry } from "./internal/server-tool-ownership.js";
import { serverTool as wrapServerTool } from "./server-tool.js";
import type { OpenBoxEnforcementOptions, OpenBoxLogger, OpenBoxRuntimeController } from "./types.js";
import {
  buildOpenBoxRuntime,
  withOpenBoxRuntime,
  type WithOpenBoxRuntimeConfig,
  type WithOpenBoxRuntimeResult
} from "./with-openbox-runtime.js";

/** Configuration accepted by `createOpenBoxCopilotKit`. */
export interface CreateOpenBoxCopilotKitOptions extends OpenBoxConfigInput {
  /** Bounds an in-flight HITL approval wait; `null` opts into an infinite wait. Default `900_000` (15 min). */
  approvalMaxWaitMs?: number | null;
  /**
   * Explicit enforcement model governing `bundle.serverTool()`-wrapped tools
   * (default `{ mode: "telemetry" }` — see `OpenBoxEnforcementOptions`).
   * `approvalMaxWaitMs` above wins over `enforcement.approvalMaxWaitMs` when
   * both are set.
   */
  enforcement?: OpenBoxEnforcementOptions;
  logger?: OpenBoxLogger;
  /** Bounded telemetry-queue options (e.g. `flushTimeoutMs`), as `middlewareOptions.telemetry` on `withOpenBoxRuntime`. */
  telemetry?: TelemetryQueueOptions;
  /** See `WithOpenBoxRuntimeConfig.validateApiKeyAtStartup`. Default `false`. */
  validateApiKeyAtStartup?: boolean;
}

/** Bundle returned by `createOpenBoxCopilotKit`. */
export interface OpenBoxCopilotKitBundle {
  /** The one base runtime this bundle owns. */
  openboxRuntime: OpenBoxRuntime;
  /**
   * Wrap a server-side tool so OpenBox governs it before its `execute` runs.
   * Bound to this bundle's own controller + resolved `enforcement` options
   * (`OpenBoxEnforcementOptions`, default `mode: "telemetry"`) — see
   * `server-tool.ts#serverTool` for the full pre-execution ordering
   * (correlation -> ownership claim -> evaluate/approve -> execute exactly
   * once -> completion telemetry -> ownership release).
   */
  serverTool: <T>(tool: T) => T;
  /**
   * Idempotent shutdown for `openboxRuntime`, which every `withRuntime`
   * runtime sharing this bundle's controller uses — call it last. Their own
   * `shutdown` only detaches; a `withRuntime` runtime with its own controller
   * (see `createOpenBoxCopilotKit`) is closed by its own `shutdown`.
   */
  shutdown: () => Promise<void>;
  /** Attach this bundle's config to a CopilotKit runtime (delegates to `withOpenBoxRuntime`). */
  withRuntime: (
    options: CopilotRuntimeOptions,
    config?: WithOpenBoxRuntimeConfig
  ) => Promise<WithOpenBoxRuntimeResult>;
}

/**
 * Bundle entry point for governed server tools. Builds one base runtime (the
 * same composition root `withOpenBoxRuntime` uses internally) plus the
 * controller-owned pieces `serverTool()` needs (`runContext`,
 * `serverToolOwnership`) and exposes it alongside a REAL `serverTool()`
 * wrapper and a `withRuntime` convenience that attaches this bundle's config
 * to a CopilotKit runtime.
 *
 * `withRuntime` attaches the CopilotKit runtime to THIS bundle's controller,
 * so its middleware and `serverTool()` share one run correlation, server-tool
 * ownership registry, telemetry queue and client: wrapped tools enforce in
 * `enforce` mode and are reported once. A `withRuntime` config that changes
 * connection/identity settings or telemetry/instrumentation options cannot
 * reuse the bundle's runtime; that runtime gets its own controller (logged),
 * owns its own `shutdown`, and `serverTool()` cannot enforce through it.
 * `bundle.shutdown()` closes the shared runtime.
 */
export async function createOpenBoxCopilotKit(
  opts: CreateOpenBoxCopilotKitOptions = {}
): Promise<OpenBoxCopilotKitBundle> {
  const { approvalMaxWaitMs, enforcement, logger, telemetry, validateApiKeyAtStartup, ...configInput } = opts;

  const resolvedApprovalMaxWaitMs =
    approvalMaxWaitMs !== undefined ? approvalMaxWaitMs : enforcement?.approvalMaxWaitMs;

  const built = buildBaseRuntime(configInput, {
    ...(logger !== undefined ? { logger } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(resolvedApprovalMaxWaitMs !== undefined ? { approvalMaxWaitMs: resolvedApprovalMaxWaitMs } : {})
  });

  if (validateApiKeyAtStartup) {
    await built.runtime.client.validateApiKey();
  }

  // Full `OpenBoxRuntimeController` shape `serverTool()` needs.
  // `interruptStore`/`runTerminalState`/`childAgentClients` are unused by
  // `serverTool()` itself (multi-agent Handoff is an AG-UI middleware
  // concern) but required by the controller shape; all default/wire the same
  // way `wrapCopilotRuntimeOptions` does for the `withRuntime` path —
  // `childAgentClients` in particular is `built.childAgentClients` so this
  // bundle's own `shutdown()` (== `built.shutdown`) closes the SAME cache.
  const controller: OpenBoxRuntimeController = {
    childAgentClients: built.childAgentClients,
    defaults: {},
    interruptStore: new InMemoryInterruptStore(),
    logger: logger ?? console,
    runContext: built.runContext,
    runTerminalState: new RunTerminalStateRegistry(),
    runtime: built.runtime,
    serverToolOwnership: new ServerToolOwnershipRegistry(),
    telemetryQueue: built.telemetryQueue
  };
  const provenance = attachOpenRouterProvenance(controller);
  controller.openRouterProvenance = provenance;
  const resolvedEnforcement = enforcement ?? {};

  const withRuntimeConfig: WithOpenBoxRuntimeConfig = {
    ...configInput,
    ...(logger !== undefined ? { logger } : {}),
    ...(validateApiKeyAtStartup !== undefined ? { validateApiKeyAtStartup } : {})
  };

  return {
    openboxRuntime: built.runtime,
    serverTool: tool => wrapServerTool(tool, controller, resolvedEnforcement),
    shutdown: async () => {
      provenance.detach();
      await built.shutdown();
    },
    withRuntime: (options, config = {}) => {
      if (canShareController(config)) {
        return buildOpenBoxRuntime(options, { ...withRuntimeConfig, ...config }, controller);
      }
      (logger ?? console).warn?.({
        note: "openbox withRuntime: config overrides connection, identity, telemetry or instrumentation settings, so this runtime gets its own controller; bundle.serverTool() cannot enforce or de-duplicate calls made through it.",
        reason: "with_runtime_separate_controller"
      });
      return withOpenBoxRuntime(options, { ...withRuntimeConfig, ...config });
    }
  };
}

/** `withRuntime` settings that apply per CopilotKit runtime, on top of the bundle's controller. */
const PER_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  "defaults",
  "logger",
  "middlewareOptions",
  "validateApiKeyAtStartup"
]);

/**
 * True when `config` changes nothing the bundle's runtime was built with, so
 * the CopilotKit runtime can share the bundle's controller (and with it the
 * run correlation `serverTool()` needs).
 */
function canShareController(config: WithOpenBoxRuntimeConfig): boolean {
  const changesRuntime = Object.entries(config).some(
    ([key, value]) => value !== undefined && !PER_RUNTIME_KEYS.has(key)
  );
  const middleware = config.middlewareOptions;
  return !changesRuntime && middleware?.telemetry === undefined && middleware?.instrumentation === undefined;
}

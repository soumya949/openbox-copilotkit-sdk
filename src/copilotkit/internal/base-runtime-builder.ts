import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { ApprovalPoller } from "@openbox-ai/openbox-sdk-ts/approvals";
import { type ClientLogger, OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { ContextStore } from "@openbox-ai/openbox-sdk-ts/context";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { OpenBoxConfigInput } from "../../config/openbox-config.js";
import { LifecycleTelemetryQueue, type TelemetryQueueOptions } from "../lifecycle-telemetry.js";
import type { OpenBoxLogger } from "../types.js";

import { ChildAgentClientCache } from "./child-agent-client-cache.js";
import { resolveCopilotKitBaseConfig, resolveTelemetryQueueOptions } from "./config-translator.js";
import {
  installCopilotKitInstrumentation,
  type OpenBoxInstrumentationController,
  type OpenBoxInstrumentationOptions
} from "./instrumentation.js";
import { RunContextStore } from "./run-context-store.js";

// Finite default so a HITL wait cannot pin a governed operation forever;
// explicit `null` (via `opts.approvalMaxWaitMs`) opts into an infinite wait.
const DEFAULT_APPROVAL_MAX_WAIT_MS = 900_000;

export interface BuildBaseRuntimeOptions {
  logger?: OpenBoxLogger;
  /** Bounds an in-flight HITL approval wait; `null` opts into an infinite wait. */
  approvalMaxWaitMs?: number | null;
  /** Bounded, non-blocking telemetry-queue configuration (Phase 3, fixes B4). */
  telemetry?: TelemetryQueueOptions;
  /** Opt-in base instrumentation (Phase 6). OFF by default -- see `config-translator.ts`'s `instrumentation.enabled` resolution. */
  instrumentation?: OpenBoxInstrumentationOptions;
}

export interface BaseRuntimeBundle {
  runtime: OpenBoxRuntime;
  runContext: RunContextStore;
  /** The ONE bounded telemetry sender this controller owns — see `shutdown`'s drain-before-close order. */
  telemetryQueue: LifecycleTelemetryQueue;
  /**
   * The ONE cache of child-scoped base clients this controller owns
   * (multi-agent Handoff, RT-F10) — see `shutdown`'s drain-before-close order.
   */
  childAgentClients: ChildAgentClientCache;
  /**
   * Present only when `instrumentation.enabled` resolved `true` (OFF by
   * default in `0.4.0`) — `undefined` means nothing was ever patched, never a
   * controller sitting idle. See `shutdown`'s drain-before-close order for
   * where `flush()`/`shutdown()` are called.
   */
  instrumentation?: OpenBoxInstrumentationController;
  /** Idempotent — safe to call more than once; later calls resolve the first call's promise. */
  shutdown: () => Promise<void>;
}

/**
 * The ONE composition root for the CopilotKit path: resolve config, build the
 * base client, an approval poller (HITL only), the stock `CoreAdapter`, the
 * base `OpenBoxRuntime`, and a controller-owned per-run context store (D7).
 *
 * Construction performs zero network calls — the base client, poller,
 * adapter, and runtime are all synchronous object graphs. Startup API-key
 * validation is an explicit, separate opt-in the caller drives itself (see
 * `wrapCopilotRuntimeOptions`'s `validateApiKeyAtStartup`), never triggered
 * from here.
 */
export function buildBaseRuntime(
  configInput: OpenBoxConfigInput,
  opts: BuildBaseRuntimeOptions = {}
): BaseRuntimeBundle {
  const config = resolveCopilotKitBaseConfig(configInput, opts.instrumentation, opts.logger);
  const clientLogger = toClientLogger(opts.logger);

  // `fromConfig` wires whichever identity method the config resolved to —
  // v3 Keycloak workload token, v2 Okta assertion, v1 DID signature, or
  // API-key only — and fails closed when a selected method lacks its key.
  const client = OpenBoxClient.fromConfig(config, clientLogger ? { logger: clientLogger } : {});

  // Aborts an in-flight approval wait on shutdown (base P0b) — composed with
  // the per-request poll timeout inside the base `ApprovalPoller`/`OpenBoxClient`,
  // never a "stop new runs" latch by itself (see the teardown-order comment
  // on `shutdown` below).
  const shutdownController = new AbortController();

  // Critical: the default `OpenBoxRuntime` builds a `CoreAdapter` with NO
  // poller, so REQUIRE_APPROVAL fails safe (rejected) unless a poller is
  // wired in here when HITL is enabled.
  const approvalPoller = config.hitl.enabled
    ? new ApprovalPoller(client, {
        maxWaitMs:
          opts.approvalMaxWaitMs === undefined
            ? DEFAULT_APPROVAL_MAX_WAIT_MS
            : opts.approvalMaxWaitMs,
        abortSignal: shutdownController.signal
      })
    : null;

  // Stock `CoreAdapter` only — no custom framework adapter (RT-F12). It
  // already enforces the no-poller + incomplete-correlation fail-safes for
  // REQUIRE_APPROVAL and routes BLOCK/HALT through `raiseLifecycleBlocked`;
  // CopilotKit-specific error translation happens at the caller boundary
  // (Phases 4-5), not inside a reimplemented adapter.
  const adapter = new CoreAdapter({ approvalPoller });

  const contextStore = new ContextStore();

  const runtime = new OpenBoxRuntime(config, {
    client,
    adapter,
    contextStore,
    ...(clientLogger ? { logger: clientLogger } : {})
  });

  // Per-run store (D7): distinct from `contextStore` above, which binds
  // per-ACTIVITY scope for the whole runtime. Adapter-owned, one instance per
  // controller — never a process-global.
  const runContext = new RunContextStore();

  // Controller-owned cache of child-scoped base clients for multi-agent
  // Handoff (RT-F10) — constructed once here (not per `OpenBoxMiddleware`
  // instance) so a child client built for one request is reused by every
  // later request this controller serves, and so shutdown has exactly one
  // cache to drain + close (see the teardown order below).
  const childAgentClients = new ChildAgentClientCache();

  // The ONE bounded, non-blocking telemetry sender this controller owns
  // (Phase 3, fixes B4) — constructed once here so `maxConcurrentSends`/
  // `maxPendingEvents` bound resource use across every run this controller
  // serves, never per-middleware-instance (see `types.ts`'s
  // `OpenBoxMiddlewareOptions.telemetry` doc). The deprecated
  // `maxEvaluatePayloadBytes` alias (Phase 6) is folded in as a
  // `maxPayloadBytes` fallback only when `opts.telemetry` doesn't already set it.
  const telemetryQueue = new LifecycleTelemetryQueue(
    { client, ...(opts.logger ? { logger: opts.logger } : {}) },
    resolveTelemetryQueueOptions(configInput, opts.telemetry, opts.logger)
  );

  // Opt-in base instrumentation (Phase 6, OFF by default in 0.4.0):
  // `config.instrumentation.enabled` is the SINGLE source of truth (resolved
  // by `resolveCopilotKitBaseConfig` above from `opts.instrumentation?.enabled`)
  // — `initOpenBoxInstrumentation` is never even CALLED when it is `false`, so
  // no target is patched and no process-wide instrumentation slot is claimed
  // (root-import purity: merely importing `instrumentation.ts` registers
  // nothing; only this conditional call can).
  const instrumentationController: OpenBoxInstrumentationController | undefined =
    config.instrumentation.enabled
      ? installCopilotKitInstrumentation(runtime, opts.instrumentation ?? {}, clientLogger)
      : undefined;

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        // Teardown order matters (RT-F10):
        //   1. stop new runs — `beginShutdown()` flips the latch
        //      SYNCHRONOUSLY, before any `await` below gives a concurrently
        //      in-flight run a window to race a new child past the check.
        //   2. abort in-flight approvals — never resolve-and-execute after
        //      shutdown has started.
        //   3. drain the bounded telemetry queue (Phase 3) — bounded by
        //      `flushTimeoutMs`; the queue itself reports+diagnoses any count
        //      still pending after the timeout, never blocking shutdown.
        //   4. flush + shut down instrumentation (Phase 6) — drains detached
        //      completed-telemetry (sync-fs, node:http/https) THEN restores
        //      every patched global; a no-op when instrumentation was never
        //      installed (`instrumentationController` is `undefined`).
        //   5. await every in-flight Handoff emission, then drop every cached
        //      child client (RT-F10) — never let the process exit mid
        //      signing-or-send.
        //   6. close the runtime last.
        childAgentClients.beginShutdown();
        shutdownController.abort();
        await telemetryQueue.flush();
        if (instrumentationController) {
          await instrumentationController.flush();
          instrumentationController.shutdown();
        }
        await childAgentClients.close();
        runtime.close();
      })();
    }
    return shutdownPromise;
  };

  return {
    childAgentClients,
    runContext,
    runtime,
    shutdown,
    telemetryQueue,
    ...(instrumentationController !== undefined ? { instrumentation: instrumentationController } : {})
  };
}

/**
 * Adapt this SDK's loose `OpenBoxLogger` (every method optional, variadic
 * args) into the base SDK's `ClientLogger` (all three methods required, a
 * single-string-argument signature). A local method left unset degrades to a
 * silent no-op rather than partially surfacing through the base client.
 */
function toClientLogger(logger: OpenBoxLogger | undefined): ClientLogger | undefined {
  if (!logger) {
    return undefined;
  }
  return {
    error: (message: string) => logger.error?.(message),
    info: (message: string) => logger.info?.(message),
    warn: (message: string) => logger.warn?.(message)
  };
}

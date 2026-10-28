import type { AbstractAgent } from "@ag-ui/client";

import type { OpenBoxConfigInput } from "../../config/openbox-config.js";
import { OpenBoxConfigError } from "../../types/errors.js";
import type {
  OpenBoxLogger,
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController,
  OpenBoxRuntimeDefaults
} from "../types.js";

import {
  openBoxAfterRequest,
  type AfterRequestMiddlewareParametersLike,
  type OpenBoxAfterRequestOptions
} from "./after-request.js";
import { buildBaseRuntime } from "./base-runtime-builder.js";
import {
  openBoxBeforeRequest,
  type BeforeRequestMiddlewareParametersLike,
  type OpenBoxBeforeRequestOptions
} from "./before-request.js";
import { InMemoryInterruptStore, type InterruptPersistencePort } from "./interrupt-store.js";
import { RunTerminalStateRegistry } from "./run-terminal-state.js";
import { ServerToolOwnershipRegistry } from "./server-tool-ownership.js";
import { wrapAgentInProxy } from "./wrap-agent-in-proxy.js";

/** Structural projection of a CopilotKit agents factory context. */
export interface AgentFactoryContextLike {
  request: Request;
}

export type AgentsRecord = Record<string, AbstractAgent>;

export type AgentsFactoryLike = (
  ctx: AgentFactoryContextLike
) => AgentsRecord | Promise<AgentsRecord>;

/**
 * The three `agents` shapes v2 accepts. `MaybePromise<Record>` is split into
 * `Record` and `Promise<Record>` to dispatch on at wrap time — the Promise
 * path is eagerly awaited so concurrent first-requests cannot race the
 * proxy-attachment.
 */
export type AgentsConfigLike =
  | AgentsRecord
  | Promise<AgentsRecord>
  | AgentsFactoryLike;

/**
 * Structural projection of a v2 `CopilotRuntimeOptions` — only the fields the
 * SDK reads or rewrites are typed. Other fields pass through as `unknown` via
 * the spread in the returned `options` object. The SDK does NOT import
 * `CopilotRuntimeOptions` directly to avoid coupling to a runtime peer
 * dependency at compile time.
 */
export interface CopilotRuntimeOptionsLike {
  agents: AgentsConfigLike;
  afterRequestMiddleware?: AfterRequestMiddlewareFnLike | undefined;
  beforeRequestMiddleware?: BeforeRequestMiddlewareFnLike | undefined;
}

export type BeforeRequestMiddlewareFnLike = (
  params: BeforeRequestMiddlewareParametersLike
) => Promise<Request | void> | Request | void;

export type AfterRequestMiddlewareFnLike = (
  params: AfterRequestMiddlewareParametersLike
) => Promise<void> | void;

/** Caller-supplied overrides on top of `OpenBoxConfigInput`. */
export interface WrapCopilotRuntimeOptionsExtras {
  /** Defaults consulted by AG-UI emissions when ALS context is absent. */
  defaults?: OpenBoxRuntimeDefaults | undefined;
  /** Logger forwarded to controller + emitter. Falls back to console. */
  logger?: OpenBoxLogger | undefined;
  /** Options passed through to `createOpenBoxMiddleware` per cloned agent. */
  middlewareOptions?: OpenBoxMiddlewareOptions | undefined;
  /** Options passed through to `openBoxAfterRequest` per request. */
  afterRequest?: OpenBoxAfterRequestOptions | undefined;
  /** Options passed through to `openBoxBeforeRequest` per request. */
  beforeRequest?: OpenBoxBeforeRequestOptions | undefined;
  /**
   * Injectable pending-interrupt persistence port (RT-F9/P2-10). Defaults to
   * an in-memory, non-durable `InMemoryInterruptStore` — inject a custom
   * port (e.g. Redis/Postgres-backed) for durability across process
   * restarts.
   */
  interruptStore?: InterruptPersistencePort | undefined;
  /**
   * Perform a real `GET /api/v1/auth/validate` round-trip at setup time.
   * Default `false` — construction never performs a network call unless this
   * is explicitly enabled. Distinct from the base config's own `validate`
   * flag, which is format/shape validation only (no network).
   */
  validateApiKeyAtStartup?: boolean | undefined;
  /**
   * Reuse an existing controller (a `createOpenBoxCopilotKit` bundle's)
   * instead of building a new base runtime. The middleware then shares the
   * owner's run correlation, server-tool ownership, telemetry queue and
   * client, so the owner's `serverTool()` can enforce and is not reported
   * twice. The owner keeps responsibility for shutdown: the returned
   * `shutdown` does not close the shared runtime.
   */
  sharedController?: OpenBoxRuntimeController | undefined;
}

/**
 * Wrap output always has both middleware functions present — the user-shape
 * may omit them, but the wrap always inserts its composed versions.
 */
export type WrappedCopilotRuntimeOptions<
  TOptions extends CopilotRuntimeOptionsLike
> = Omit<
  TOptions,
  "agents" | "beforeRequestMiddleware" | "afterRequestMiddleware"
> & {
  agents: AgentsConfigLike;
  afterRequestMiddleware: AfterRequestMiddlewareFnLike;
  beforeRequestMiddleware: BeforeRequestMiddlewareFnLike;
};

export interface WrapCopilotRuntimeOptionsResult<
  TOptions extends CopilotRuntimeOptionsLike
> {
  controller: OpenBoxRuntimeController;
  options: WrappedCopilotRuntimeOptions<TOptions>;
  /**
   * Idempotent shutdown hook. Kept as part of the public tuple contract even
   * when there is no client-side cleanup to perform.
   */
  shutdown: () => Promise<void>;
}

const DEFAULT_LOGGER: OpenBoxLogger = {
  debug: (...args) => {
    console.debug("[openbox-copilotkit]", ...args);
  },
  error: (...args) => {
    console.error("[openbox-copilotkit]", ...args);
  },
  info: (...args) => {
    console.info("[openbox-copilotkit]", ...args);
  },
  warn: (...args) => {
    console.warn("[openbox-copilotkit]", ...args);
  }
};

/**
 * Build an OpenBox controller + a wrapped copy of the user's
 * `CopilotRuntimeOptions`. The wrapped options:
 *
 *   1. Compose user `before/afterRequestMiddleware` with OpenBox helpers via
 *      try/finally semantics — OpenBox observation runs regardless of user
 *      throws; user errors propagate after OpenBox records.
 *   2. Replace the `agents` config with a proxy-wrapped variant. The original
 *      record / Promise / factory is never mutated; per-request `clone()`
 *      calls produce fresh AG-UI agents with the OpenBox middleware attached.
 *   3. Eagerly resolve Promise-shape agents at wrap time so the first
 *      concurrent requests cannot race the proxy attachment.
 *
 * Returns `{ options, controller, shutdown }`. The caller is responsible for
 * attaching the controller to the constructed runtime before serving requests.
 *
 * INTERNAL — not exported from the public `index.ts`. The public surface is
 * `createOpenBoxMiddleware` + `withOpenBoxRuntime`.
 */
export async function wrapCopilotRuntimeOptions<
  TOptions extends CopilotRuntimeOptionsLike
>(
  options: TOptions,
  configInput: OpenBoxConfigInput = {},
  extras: WrapCopilotRuntimeOptionsExtras = {}
): Promise<WrapCopilotRuntimeOptionsResult<TOptions>> {
  const shared = extras.sharedController;
  const logger = extras.logger ?? shared?.logger ?? DEFAULT_LOGGER;
  const { controller, shutdown } = shared
    ? {
        controller: {
          ...shared,
          defaults: extras.defaults ?? shared.defaults,
          logger
        } satisfies OpenBoxRuntimeController,
        // The owner (the bundle) closes the shared runtime.
        shutdown: () => Promise.resolve()
      }
    : buildOwnController(configInput, extras, logger);
  const runtime = controller.runtime;

  if (extras.validateApiKeyAtStartup) {
    await runtime.client.validateApiKey();
  }

  const markerSymbol = Symbol("openbox.copilotkit.wrap");
  const middlewareOptions = extras.middlewareOptions;

  // Fail loudly at setup for multi-agent identity misconfiguration.
  const multiAgent = middlewareOptions?.multiAgent;
  if (multiAgent?.enabled && !(multiAgent.parentAgentDid ?? runtime.config.agentDid)) {
    throw new OpenBoxConfigError(
      "OpenBox multi-agent mode is enabled but no parent agent DID is available. " +
        "Set middlewareOptions.multiAgent.parentAgentDid or configure agentDid/agentPrivateKey."
    );
  }

  const wrappedAgents = await wrapAgents(options.agents, {
    controller,
    markerSymbol,
    middlewareOptions
  });

  const beforeOpts = extras.beforeRequest ?? {};
  const afterOpts = extras.afterRequest ?? {};

  const wrappedBefore = composeBeforeRequestMiddleware(
    options.beforeRequestMiddleware,
    beforeOpts,
    logger
  );
  const wrappedAfter = composeAfterRequestMiddleware(
    options.afterRequestMiddleware,
    afterOpts,
    logger
  );

  const nextOptions = {
    ...options,
    afterRequestMiddleware: wrappedAfter,
    agents: wrappedAgents,
    beforeRequestMiddleware: wrappedBefore
  } as unknown as WrappedCopilotRuntimeOptions<TOptions>;

  return { controller, options: nextOptions, shutdown };
}

/** A controller over a newly built base runtime, owned (and shut down) by this wrap. */
function buildOwnController(
  configInput: OpenBoxConfigInput,
  extras: WrapCopilotRuntimeOptionsExtras,
  logger: OpenBoxLogger
): { controller: OpenBoxRuntimeController; shutdown: () => Promise<void> } {
  const telemetryOptions = extras.middlewareOptions?.telemetry;
  const instrumentationOptions = extras.middlewareOptions?.instrumentation;
  const { runtime, runContext, telemetryQueue, childAgentClients, shutdown } = buildBaseRuntime(
    configInput,
    {
      logger,
      ...(telemetryOptions !== undefined ? { telemetry: telemetryOptions } : {}),
      ...(instrumentationOptions !== undefined ? { instrumentation: instrumentationOptions } : {})
    }
  );
  return {
    controller: {
      runtime,
      runContext,
      telemetryQueue,
      childAgentClients,
      defaults: extras.defaults ?? {},
      logger,
      serverToolOwnership: new ServerToolOwnershipRegistry(),
      interruptStore: extras.interruptStore ?? new InMemoryInterruptStore(),
      runTerminalState: new RunTerminalStateRegistry()
    },
    shutdown
  };
}

interface WrapAgentsContext {
  controller: OpenBoxRuntimeController;
  markerSymbol: symbol;
  middlewareOptions?: OpenBoxMiddlewareOptions | undefined;
}

/**
 * Dispatch on the three `agents` shapes:
 *
 *   - Function (factory): return a new factory that wraps each call result.
 *     Per-call wrapping is correct — factories return NEW agent instances
 *     per request, so each instance needs its own proxy.
 *   - Promise: `await` at wrap time and treat as record. Eager resolution
 *     avoids the concurrent-first-request race (no factory case, no
 *     `runtime.agentsReady` API in v2).
 *   - Record: map each agent through `wrapAgentInProxy`.
 */
async function wrapAgents(
  agents: AgentsConfigLike,
  ctx: WrapAgentsContext
): Promise<AgentsConfigLike> {
  if (typeof agents === "function") {
    const factory = agents;
    return (factoryCtx: AgentFactoryContextLike) =>
      Promise.resolve(factory(factoryCtx)).then(result =>
        wrapRecord(result, ctx)
      );
  }

  if (isThenable(agents)) {
    const resolved = await agents;
    return wrapRecord(resolved, ctx);
  }

  return wrapRecord(agents, ctx);
}

function wrapRecord(
  record: AgentsRecord,
  ctx: WrapAgentsContext
): AgentsRecord {
  const entries = Object.entries(record).map(
    ([key, agent]) =>
      [
        key,
        wrapAgentInProxy(agent, {
          controller: ctx.controller,
          markerSymbol: ctx.markerSymbol,
          middlewareOptions: ctx.middlewareOptions
        })
      ] as const
  );
  return Object.fromEntries(entries);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Try/finally composition: OpenBox observation runs regardless of whether
 * the user's `beforeRequestMiddleware` succeeded. If the user throws,
 * OpenBox still runs (so ALS context + DID signing still happen); the user's
 * error is re-thrown after OpenBox completes.
 *
 * If user middleware returns a modified `Request`, OpenBox sees the modified
 * request. If both user and OpenBox produce a request, OpenBox's takes
 * precedence (it owns the identity headers — must be the final word on the
 * outbound request).
 */
function composeBeforeRequestMiddleware(
  userBefore: BeforeRequestMiddlewareFnLike | undefined,
  beforeOpts: OpenBoxBeforeRequestOptions,
  logger: OpenBoxLogger
): BeforeRequestMiddlewareFnLike {
  return async params => {
    let userResult: Request | undefined;
    let userErr: unknown;

    if (userBefore) {
      try {
        const value = await userBefore(params);
        if (value) {
          userResult = value;
        }
      } catch (err) {
        userErr = err;
      }
    }

    const paramsForOpenBox: BeforeRequestMiddlewareParametersLike = userResult
      ? { ...params, request: userResult }
      : params;

    let openBoxResult: Request | undefined;
    try {
      const value = await openBoxBeforeRequest(
        params.runtime,
        beforeOpts
      )(paramsForOpenBox);
      if (value) {
        openBoxResult = value;
      }
    } catch (openBoxErr) {
      logger.warn?.({
        err: openBoxErr,
        note: "openbox wrap-copilot-runtime-options: before-request observation threw — swallowed"
      });
    }

    if (userErr) {
      throw toThrowable(userErr);
    }

    return openBoxResult ?? userResult;
  };
}

/**
 * After: same try/finally shape — observe regardless of user-middleware
 * outcome, then re-throw the user error if any. OpenBox errors are swallowed
 * (warn-logged) to preserve the `onApiError: "fail_open"` contract on the
 * response path.
 */
function composeAfterRequestMiddleware(
  userAfter: AfterRequestMiddlewareFnLike | undefined,
  afterOpts: OpenBoxAfterRequestOptions,
  logger: OpenBoxLogger
): AfterRequestMiddlewareFnLike {
  return async params => {
    let userErr: unknown;

    if (userAfter) {
      try {
        await userAfter(params);
      } catch (err) {
        userErr = err;
      }
    }

    try {
      await openBoxAfterRequest(params.runtime, afterOpts)(params);
    } catch (openBoxErr) {
      logger.warn?.({
        err: openBoxErr,
        note: "openbox wrap-copilot-runtime-options: after-request observation threw — swallowed"
      });
    }

    if (userErr) {
      throw toThrowable(userErr);
    }
  };
}

/**
 * Preserve user-thrown values across the OpenBox try/finally hop while
 * satisfying lint's `only-throw-error` rule. Real Error instances pass
 * through unchanged so callers' `instanceof` checks and stack traces are
 * intact; non-Error throws are wrapped in an Error that retains the
 * original value as `cause`.
 */
function toThrowable(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value), { cause: value });
}

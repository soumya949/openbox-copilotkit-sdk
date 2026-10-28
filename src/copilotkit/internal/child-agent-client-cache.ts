import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";

/**
 * Controller-owned cache of child-scoped base `OpenBoxClient`s used to sign +
 * emit a multi-agent `Handoff` AS the receiving child — Core derives
 * `to_agent` from the child-signed AIP headers, never the payload (RT-F10;
 * verified `governance.go:229`/`governance_workflow.go:171`). Keyed by child
 * agent DID so the Ed25519 seed is decoded once per child and the client is
 * reused across every delegation to that same child for the lifetime of the
 * CONTROLLER (previously this cache lived on one `OpenBoxMiddleware`
 * instance; since a fresh middleware is built per request/agent-clone —
 * `wrapAgentInProxy` — that never actually achieved cross-request reuse.
 * Moving ownership here fixes that and gives the cache a single well-defined
 * close path: `base-runtime-builder.ts`'s bundle shutdown).
 */
export class ChildAgentClientCache {
  readonly #clients = new Map<string, OpenBoxClient>();
  // In-flight handoff-emission promises, grouped per run: a run's own
  // terminal/error path drains exactly its own outstanding work
  // (`releaseRun`), and `close` drains every run's outstanding work before
  // the cache is torn down — never let the process/bundle shut down mid
  // signing-or-send.
  readonly #pendingByRun = new Map<string, Set<Promise<unknown>>>();
  #shuttingDown = false;
  #closePromise: Promise<void> | undefined;

  /** Whether shutdown has started — `getOrCreate` refuses new children from this point on. */
  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /**
   * Synchronously latch OFF new child construction. Split out of `close()` so
   * a caller (`base-runtime-builder.ts`'s `shutdown`) can flip this the very
   * FIRST thing it does — before any `await` (telemetry drain, approval
   * abort, ...) gives a concurrently in-flight run a window to race a NEW
   * delegation past the check. `close()` also sets this flag (idempotent —
   * setting it again is a no-op) for a caller that only ever calls `close()`.
   */
  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  /**
   * Return the cached child client for `childAgentDid`, or build + cache one
   * via `build()`. Returns `undefined` once shutdown has started (RT-F10)
   * instead of calling `build()` — the caller must fail that delegation
   * safely (exactly like a missing/invalid child credential), never falling
   * back to an unsigned or parent-signed send. `build()` may throw (e.g. a
   * malformed child DID/key); the throw propagates to the caller uncaught —
   * this cache never swallows a construction error itself.
   */
  getOrCreate(childAgentDid: string, build: () => OpenBoxClient): OpenBoxClient | undefined {
    if (this.#shuttingDown) {
      return undefined;
    }
    const cached = this.#clients.get(childAgentDid);
    if (cached) {
      return cached;
    }
    const built = build();
    this.#clients.set(childAgentDid, built);
    return built;
  }

  /**
   * Track an in-flight handoff-emission promise against `runId`. Callers
   * still await `pending` themselves — this side-channel registration only
   * lets `releaseRun`/`close` observe (and wait out) the SAME in-flight work
   * from a concurrent run-terminal or shutdown path. Self-removes once
   * settled so a long-lived controller never accumulates settled entries.
   */
  trackHandoff(runId: string, pending: Promise<unknown>): void {
    let set = this.#pendingByRun.get(runId);
    if (!set) {
      set = new Set();
      this.#pendingByRun.set(runId, set);
    }
    set.add(pending);
    // Never becomes an unhandled rejection: the caller already
    // awaits/handles `pending` directly (`#maybeEmitHandoff` never throws) —
    // this second reference exists solely for cleanup bookkeeping.
    void pending.catch(() => undefined).finally(() => {
      set.delete(pending);
      if (set.size === 0) {
        this.#pendingByRun.delete(runId);
      }
    });
  }

  /**
   * Await + drop every in-flight handoff tracked for `runId` (a run's
   * terminal/error path, RT-F10). In the common case every tracked promise
   * has already settled by the time this runs (the middleware always awaits
   * its own handoff emission before reaching the run-terminal path) — this
   * is a defensive drain, not a source of added latency. Idempotent (a
   * second call for the same run finds nothing left to await).
   */
  async releaseRun(runId: string): Promise<void> {
    const set = this.#pendingByRun.get(runId);
    if (!set) {
      return;
    }
    this.#pendingByRun.delete(runId);
    await Promise.allSettled([...set]);
  }

  /**
   * Idempotent shutdown: latch OFF new child construction (see
   * `beginShutdown` — redundant if the caller already called it, a no-op
   * either way), await every still-in-flight handoff emission across every
   * run (never let the process exit mid signing-or-send), then close and drop
   * every cached child client. Safe to call more than once — later calls resolve
   * the first call's promise.
   */
  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = (async () => {
        this.#shuttingDown = true;
        const pending = [...this.#pendingByRun.values()].flatMap(set => [...set]);
        this.#pendingByRun.clear();
        await Promise.allSettled(pending);
        // Release each child's identity material (signing keys, workload tokens).
        for (const client of this.#clients.values()) {
          client.close();
        }
        this.#clients.clear();
      })();
    }
    return this.#closePromise;
  }
}

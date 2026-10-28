const KEY_SEPARATOR = "::";

// Mirrors the base HITL approval wait's own default bound
// (`base-runtime-builder.ts`'s `DEFAULT_APPROVAL_MAX_WAIT_MS`) — an
// interrupt is conceptually the same "paused awaiting a human" shape, so the
// same order-of-magnitude default is reused here.
export const DEFAULT_INTERRUPT_TTL_MS = 900_000;

// Bounds memory when a run interrupts and is NEVER resumed (the run that
// owns these entries, by definition, never reaches a normal terminal
// cleanup — see `openbox-middleware.ts`'s terminal handling, which
// deliberately does NOT clear a just-interrupted run's own entries). FIFO
// eviction is a safety net on top of the per-entry TTL, not a replacement
// for it.
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Snapshot of an interrupted activity, persisted long enough to survive
 * until a resume run reads it back. Deliberately independent of the
 * middleware's per-run `ToolCallBufferEntry` (which is garbage-collected the
 * moment the interrupted run's `Observable` completes) — every field this
 * type needs to emit a correcting `ActivityCompleted` for the ORIGINAL run
 * is captured up front, at interrupt time.
 */
export interface PendingInterrupt {
  /** = the interrupt's own `id` (RT-F5) — never the AG-UI `toolCallId`. */
  readonly activityId: string;
  readonly activityArgs?: unknown;
  /** The ORIGINAL (interrupted) run's multi-agent session id, if any — never the resuming run's own. */
  readonly multiAgentSessionId?: string | undefined;
  readonly message?: string | undefined;
  readonly reason: string;
  readonly startTime?: number | undefined;
  readonly toolName: string;
  readonly workflowId: string;
}

/**
 * MANDATORY injectable persistence port for pending interrupts (RT-F9 /
 * P2-10). `save`/`take`/`clearRun` are keyed on `(runId, interruptId)` — the
 * ORIGINAL (interrupted) run's id, not whatever run later resumes it.
 *
 * `take` is DESTRUCTIVE (removes the entry) — resuming an interrupt consumes
 * it exactly once. A miss (never saved, already taken, or TTL-expired) MUST
 * surface to the caller as `undefined`, which the middleware turns into a
 * typed failure — NEVER a fabricated `ActivityCompleted` (RT-F9).
 *
 * The bundled `InMemoryInterruptStore` default is explicitly NON-DURABLE:
 * a process restart silently orphans any Core workflow still awaiting
 * resume (no Core-side reaper exists to reap it either). Operators needing
 * durability across restarts must inject their own port (e.g. backed by
 * Redis/Postgres) — this interface is the seam for that, never a promise
 * that the in-memory default is safe to rely on in production HA setups.
 */
export interface InterruptPersistencePort {
  /** Persist `interrupts` for `runId`, each expiring after `ttlMs` (local correlation cleanup only — never a Core-visible effect). */
  save(runId: string, interrupts: readonly PendingInterrupt[], ttlMs: number): void;
  /** Consume + return the pending interrupt for `(runId, interruptId)`, or `undefined` on a miss/expiry. */
  take(runId: string, interruptId: string): PendingInterrupt | undefined;
  /** Drop every remaining entry for `runId` (bounds memory on a long-lived runtime). */
  clearRun(runId: string): void;
  /**
   * Whether `runId` still has unexpired pending interrupts. Optional: when
   * absent, a resume that resolves interrupts is taken to resolve the run's
   * last ones, and the interrupted run is closed.
   */
  hasPending?(runId: string): boolean;
}

interface StoredEntry {
  readonly expiresAt: number;
  readonly runId: string;
  readonly value: PendingInterrupt;
}

/**
 * Default in-memory `InterruptPersistencePort`. Bounded by a per-entry TTL
 * (lazily enforced on `take`) plus a hard entry-count cap (FIFO eviction) so
 * an interrupted-and-abandoned run can never grow this map unbounded.
 *
 * NEVER durable — see the interface doc. This class exists so
 * `createOpenBoxMiddleware`/`withOpenBoxRuntime` have a working default; it
 * is not a substitute for a real store in a multi-process or HA deployment.
 */
export interface InMemoryInterruptStoreOptions {
  maxEntries?: number;
  /** Injectable clock (mirrors `SpanBuffer`'s own `clock` option) — lets tests exercise TTL expiry deterministically. Defaults to `Date.now`. */
  clock?: () => number;
}

export class InMemoryInterruptStore implements InterruptPersistencePort {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #keysByRun = new Map<string, Set<string>>();
  readonly #maxEntries: number;
  readonly #clock: () => number;

  public constructor(options: InMemoryInterruptStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#clock = options.clock ?? Date.now;
  }

  public save(runId: string, interrupts: readonly PendingInterrupt[], ttlMs: number): void {
    if (interrupts.length === 0) {
      return;
    }
    const expiresAt = this.#clock() + Math.max(0, ttlMs);
    const keysForRun = this.#keysForRun(runId);
    for (const value of interrupts) {
      const key = InMemoryInterruptStore.#key(runId, value.activityId);
      this.#entries.set(key, { expiresAt, runId, value });
      keysForRun.add(key);
      this.#evictOldestIfOverCapacity();
    }
  }

  public take(runId: string, interruptId: string): PendingInterrupt | undefined {
    const key = InMemoryInterruptStore.#key(runId, interruptId);
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.#delete(entry.runId, key);
    // Expired: behaves exactly like "never existed" — the caller's
    // resume-with-no-pending branch (RT-F9) already treats an `undefined`
    // result as a typed failure, never a fabricated completion.
    return entry.expiresAt > this.#clock() ? entry.value : undefined;
  }

  public hasPending(runId: string): boolean {
    const now = this.#clock();
    for (const key of this.#keysByRun.get(runId) ?? []) {
      const entry = this.#entries.get(key);
      if (entry && entry.expiresAt > now) {
        return true;
      }
    }
    return false;
  }

  public clearRun(runId: string): void {
    const keysForRun = this.#keysByRun.get(runId);
    if (!keysForRun) {
      return;
    }
    for (const key of keysForRun) {
      this.#entries.delete(key);
    }
    this.#keysByRun.delete(runId);
  }

  #keysForRun(runId: string): Set<string> {
    let keys = this.#keysByRun.get(runId);
    if (!keys) {
      keys = new Set();
      this.#keysByRun.set(runId, keys);
    }
    return keys;
  }

  #delete(runId: string, key: string): void {
    this.#entries.delete(key);
    this.#keysByRun.get(runId)?.delete(key);
  }

  #evictOldestIfOverCapacity(): void {
    if (this.#entries.size <= this.#maxEntries) {
      return;
    }
    const oldest = this.#entries.entries().next().value;
    if (!oldest) {
      return;
    }
    const [oldestKey, oldestEntry] = oldest;
    this.#delete(oldestEntry.runId, oldestKey);
  }

  static #key(runId: string, interruptId: string): string {
    return `${runId}${KEY_SEPARATOR}${interruptId}`;
  }
}

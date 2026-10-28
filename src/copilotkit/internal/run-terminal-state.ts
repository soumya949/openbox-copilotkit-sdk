// Bounds memory if a consumer never calls `clearRun` (e.g. an adopter who
// wires the AG-UI middleware without also wiring `openBoxAfterRequest`) —
// mirrors `ServerToolOwnershipRegistry`'s own bounded-map precedent.
const DEFAULT_MAX_ENTRIES = 10_000;

/** Per-run output-dedup snapshot (RT-F14). */
export interface RunTerminalStateSnapshot {
  /** Set when `RUN_FINISHED.outcome` was an interrupt — the run is suspended, not done. */
  readonly interrupted: boolean;
  /** Set when the AG-UI stream itself already recorded the run's output (on `WorkflowCompleted`). */
  readonly outputEmitted: boolean;
}

const DEFAULT_SNAPSHOT: RunTerminalStateSnapshot = {
  interrupted: false,
  outputEmitted: false
};

/**
 * Controller-owned, per-run registry recording whether THIS run's AG-UI
 * stream already emitted its terminal output signal, and whether it ended
 * suspended (interrupted) rather than finished. Read by BOTH
 * `openbox-middleware.ts` (writer) and `internal/after-request.ts` (reader
 * + owner of `clearRun`, since `after-request` is the last consumer in a
 * request's lifecycle — see that module's dedup guard).
 *
 * Mirrors `ServerToolOwnershipRegistry`: one instance per controller, never
 * a process/module global, bounded so a caller that forgets `clearRun`
 * cannot grow this map without limit.
 */
export class RunTerminalStateRegistry {
  readonly #states = new Map<string, RunTerminalStateSnapshot>();
  readonly #maxEntries: number;

  public constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Record that the AG-UI stream itself emitted the run's terminal output signal. */
  public markOutputEmitted(runId: string): void {
    this.#update(runId, { outputEmitted: true });
  }

  /** Record that the run ended suspended (an interrupt outcome), not finished. */
  public markInterrupted(runId: string): void {
    this.#update(runId, { interrupted: true });
  }

  /** Current dedup snapshot for `runId` — defaults (neither emitted nor interrupted) when nothing was recorded. */
  public get(runId: string): RunTerminalStateSnapshot {
    return this.#states.get(runId) ?? DEFAULT_SNAPSHOT;
  }

  /** Drop `runId`'s entry once every terminal consumer (middleware + after-request) is done reading it. */
  public clearRun(runId: string): void {
    this.#states.delete(runId);
  }

  #update(runId: string, patch: Partial<RunTerminalStateSnapshot>): void {
    const current = this.#states.get(runId) ?? DEFAULT_SNAPSHOT;
    this.#states.set(runId, { ...current, ...patch });
    this.#evictOldestIfOverCapacity();
  }

  #evictOldestIfOverCapacity(): void {
    if (this.#states.size <= this.#maxEntries) {
      return;
    }
    const oldestKey = this.#states.keys().next().value;
    if (oldestKey !== undefined) {
      this.#states.delete(oldestKey);
    }
  }
}

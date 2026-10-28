import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { describe, expect, it, vi } from "vitest";

import { ChildAgentClientCache } from "../../../src/copilotkit/internal/child-agent-client-cache.js";

function fakeClient(): OpenBoxClient {
  return { close: vi.fn(), evaluate: vi.fn() } as unknown as OpenBoxClient;
}

describe("ChildAgentClientCache", () => {
  it("getOrCreate builds and caches a client per childAgentDid", () => {
    const cache = new ChildAgentClientCache();
    const build = vi.fn(fakeClient);

    const first = cache.getOrCreate("did:aip:child-1", build);
    const second = cache.getOrCreate("did:aip:child-1", build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("getOrCreate builds a separate client per distinct childAgentDid", () => {
    const cache = new ChildAgentClientCache();
    const clientA = cache.getOrCreate("did:aip:child-a", fakeClient);
    const clientB = cache.getOrCreate("did:aip:child-b", fakeClient);

    expect(clientA).not.toBe(clientB);
  });

  it("getOrCreate propagates a build() throw without caching anything", () => {
    const cache = new ChildAgentClientCache();
    const build = (): OpenBoxClient => {
      throw new Error("bad child key");
    };

    expect(() => cache.getOrCreate("did:aip:child-1", build)).toThrow("bad child key");
    // A later, successful build for the SAME did is not blocked by the prior throw.
    const client = cache.getOrCreate("did:aip:child-1", fakeClient);
    expect(client).toBeDefined();
  });

  it("isShuttingDown is false before beginShutdown/close", () => {
    const cache = new ChildAgentClientCache();
    expect(cache.isShuttingDown).toBe(false);
  });

  it("beginShutdown synchronously refuses new children without waiting on close()", () => {
    const cache = new ChildAgentClientCache();
    cache.beginShutdown();

    expect(cache.isShuttingDown).toBe(true);
    const build = vi.fn(fakeClient);
    expect(cache.getOrCreate("did:aip:child-1", build)).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });

  it("getOrCreate returns undefined once close() has started (RT-F10 latch), never calling build()", async () => {
    const cache = new ChildAgentClientCache();
    const closePromise = cache.close();
    const build = vi.fn(fakeClient);

    expect(cache.getOrCreate("did:aip:child-1", build)).toBeUndefined();
    expect(build).not.toHaveBeenCalled();

    await closePromise;
  });

  it("close() is idempotent -- a second call resolves the same promise and does not re-run teardown", async () => {
    const cache = new ChildAgentClientCache();
    cache.getOrCreate("did:aip:child-1", fakeClient);

    const first = cache.close();
    const second = cache.close();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(first).toBe(second);

    // A third call after both resolved is still a safe no-op.
    await expect(cache.close()).resolves.toBeUndefined();
  });

  it("close() awaits every in-flight tracked handoff (across every run) before resolving", async () => {
    const cache = new ChildAgentClientCache();
    let resolvePending!: () => void;
    const pending = new Promise<void>(resolve => {
      resolvePending = resolve;
    });
    cache.trackHandoff("run-1", pending);

    let closed = false;
    const closePromise = cache.close().then(() => {
      closed = true;
    });

    // Give the microtask queue a chance to run — close() must still be
    // waiting on `pending`, not resolved early.
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);

    resolvePending();
    await closePromise;
    expect(closed).toBe(true);
  });

  it("close() tolerates a tracked handoff promise that rejects (never lets the rejection propagate)", async () => {
    const cache = new ChildAgentClientCache();
    cache.trackHandoff("run-1", Promise.reject(new Error("handoff send failed")));

    await expect(cache.close()).resolves.toBeUndefined();
  });

  it("releaseRun awaits + drops only the tracked handoffs for that run", async () => {
    const cache = new ChildAgentClientCache();
    let resolveRun1!: () => void;
    const run1Pending = new Promise<void>(resolve => {
      resolveRun1 = resolve;
    });
    cache.trackHandoff("run-1", run1Pending);
    cache.trackHandoff("run-2", Promise.resolve());

    resolveRun1();
    await expect(cache.releaseRun("run-1")).resolves.toBeUndefined();
    // releaseRun on an unrelated/unknown run is a safe no-op.
    await expect(cache.releaseRun("run-2")).resolves.toBeUndefined();
    await expect(cache.releaseRun("never-tracked")).resolves.toBeUndefined();
  });

  it("releaseRun does NOT flip the shuttingDown latch — only close()/beginShutdown() do", async () => {
    const cache = new ChildAgentClientCache();
    cache.trackHandoff("run-1", Promise.resolve());

    await cache.releaseRun("run-1");

    expect(cache.isShuttingDown).toBe(false);
    expect(cache.getOrCreate("did:aip:child-1", fakeClient)).toBeDefined();
  });
});

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { forkThreadFromLatestStable, type ThreadForkDependencies } from "./thread-fork";

const source = {
  environmentId: EnvironmentId.make("environment-1"),
  id: ThreadId.make("thread-source"),
  title: "Fix login",
};
const forkedThread = { id: ThreadId.make("thread-fork") };

function setup(overrides: Partial<ThreadForkDependencies<typeof forkedThread>> = {}) {
  const alerts: { title: string; message: string }[] = [];
  const deps = {
    inFlight: new Set<string>(),
    newThreadId: () => forkedThread.id,
    fork: vi.fn(async () => AsyncResult.success(undefined)),
    waitForThread: vi.fn(async () => forkedThread),
    openThread: vi.fn(),
    alert: (title: string, message: string) => alerts.push({ title, message }),
    ...overrides,
  } satisfies ThreadForkDependencies<typeof forkedThread>;
  return { deps, alerts };
}

describe("forkThreadFromLatestStable", () => {
  it("forks from the latest stable point and opens the fork once it reaches the device", async () => {
    const { deps, alerts } = setup();

    expect(await forkThreadFromLatestStable(source, deps)).toBe(true);

    expect(deps.fork).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: {
        sourceThreadId: source.id,
        targetThreadId: forkedThread.id,
        title: "Fix login fork",
        creationSource: "mobile",
      },
    });
    expect(deps.waitForThread).toHaveBeenCalledWith(source.environmentId, forkedThread.id);
    expect(deps.openThread).toHaveBeenCalledWith(forkedThread);
    expect(alerts).toEqual([]);
  });

  it("forks once when the thread is chosen again before the first fork returns", async () => {
    const pending = Promise.withResolvers<AtomCommandResult<unknown, unknown>>();
    const fork = vi.fn(() => pending.promise);
    const { deps } = setup({ fork });

    const first = forkThreadFromLatestStable(source, deps);
    expect(await forkThreadFromLatestStable(source, deps)).toBe(false);
    pending.resolve(AsyncResult.success(undefined));
    expect(await first).toBe(true);
    expect(fork).toHaveBeenCalledOnce();

    expect(await forkThreadFromLatestStable(source, deps)).toBe(true);
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected fork and lets the user try again", async () => {
    const fork = vi.fn(async () => AsyncResult.failure(Cause.fail(new Error("Thread is busy"))));
    const { deps, alerts } = setup({ fork });

    expect(await forkThreadFromLatestStable(source, deps)).toBe(false);
    expect(alerts).toEqual([{ title: "Could not fork conversation", message: "Thread is busy" }]);
    expect(deps.openThread).not.toHaveBeenCalled();

    expect(await forkThreadFromLatestStable(source, deps)).toBe(false);
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the fork is interrupted", async () => {
    const { deps, alerts } = setup({
      fork: async () => AsyncResult.failure(Cause.interrupt()),
    });

    expect(await forkThreadFromLatestStable(source, deps)).toBe(false);
    expect(alerts).toEqual([]);
    expect(deps.waitForThread).not.toHaveBeenCalled();
  });

  it("says the fork was created when it never reaches the device", async () => {
    const { deps, alerts } = setup({ waitForThread: async () => null });

    expect(await forkThreadFromLatestStable(source, deps)).toBe(false);
    expect(alerts.map((alert) => alert.title)).toEqual([
      "Conversation forked, but could not open it",
    ]);
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("says the fork was created when opening it fails", async () => {
    const { deps, alerts } = setup({
      openThread: () => {
        throw new Error("Navigator is not ready");
      },
    });

    expect(await forkThreadFromLatestStable(source, deps)).toBe(false);
    expect(alerts).toEqual([
      { title: "Conversation forked, but could not open it", message: "Navigator is not ready" },
    ]);
  });
});

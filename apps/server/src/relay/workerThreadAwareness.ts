/**
 * Fork: worker threads (tagged "worker") stay quiet on phones. Their runs get no live card and
 * no completion alert; a question, an approval or a failure still reaches the user.
 */
import { isWorkerThread, type RunId, type ThreadId } from "@t3tools/contracts";

/** Phases a worker still publishes, because the run needs the user or failed. */
function workerPhaseNeedsUser(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "failed";
}

/** A worker's state as phones should see it: null (like an archived thread) unless it needs the user. */
export function quietWorkerAwarenessState<State extends { readonly phase: string }>(
  thread: { readonly tags?: ReadonlyArray<string> | undefined },
  state: State | null,
): State | null {
  return state !== null && isWorkerThread(thread) && !workerPhaseNeedsUser(state.phase)
    ? null
    : state;
}

interface WorkerRunThread {
  readonly id: ThreadId;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly latestRunId?: RunId | null | undefined;
}

/**
 * Remembers each thread's latest run seen while it was a worker, so a run that finished quietly
 * does not alert as a fresh completion after the thread stops being a worker.
 */
export function makeWorkerRunMemory() {
  const workerRunByThread = new Map<ThreadId, RunId>();
  return {
    observe(thread: WorkerRunThread): void {
      const remembered = workerRunByThread.get(thread.id);
      if (isWorkerThread(thread)) {
        if (thread.latestRunId != null) workerRunByThread.set(thread.id, thread.latestRunId);
      } else if (remembered !== undefined && remembered !== thread.latestRunId) {
        workerRunByThread.delete(thread.id);
      }
    },
    /** True when the thread's latest run was seen while the thread was a worker. */
    seenAsWorker(thread: WorkerRunThread): boolean {
      return thread.latestRunId != null && workerRunByThread.get(thread.id) === thread.latestRunId;
    },
    forget(threadId: ThreadId): void {
      workerRunByThread.delete(threadId);
    },
  };
}

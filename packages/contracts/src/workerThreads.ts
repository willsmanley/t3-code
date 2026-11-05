/**
 * Fork: a thread tagged "worker" lives on the Workers tab instead of Projects, and its runs stay
 * quiet unless they need the user (a question, an approval or a failure). The user sets it.
 */
export const WORKER_THREAD_TAG = "worker";

export function isWorkerThread(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
}): boolean {
  return thread.tags?.includes(WORKER_THREAD_TAG) ?? false;
}

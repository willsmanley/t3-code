import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isWorkerThread } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

/**
 * Fork: threads tagged "worker" run scheduled jobs in the background. The thread list keeps them
 * out of the way in a collapsed Workers shelf at the end, like the web's Workers tab.
 */
export interface ThreadListV2WorkersShelfListItem {
  readonly type: "v2-workers-shelf";
  readonly key: "v2-workers-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

/** The end of Android's Workers tab: the no-workers hint and the jobs in project threads. */
export interface ThreadListV2WorkerJobsListItem {
  readonly type: "v2-worker-jobs";
  readonly key: "v2-worker-jobs";
  readonly workerCount: number;
}

/** Waiting on the user's approval or answer, or its latest run failed. */
export function workerThreadNeedsUser(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "runtime"
    | "latestRun"
  >,
): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    thread.runtime?.status === "failed" ||
    thread.latestRun?.status === "failed"
  );
}

/** A worker the list moves into the Workers shelf; one that needs the user stays in place. */
export function isShelvedWorkerThread(thread: EnvironmentThreadShell): boolean {
  return isWorkerThread(thread.source) && !workerThreadNeedsUser(thread);
}

export const WORKER_TAG_MENU_ACTION_ID = "worker-tag";

const MOVE_TO_WORKERS_MENU_ACTION: MenuAction = {
  id: WORKER_TAG_MENU_ACTION_ID,
  title: "Move to Workers",
  image: "calendar.badge.clock",
};

const MOVE_TO_PROJECTS_MENU_ACTION: MenuAction = {
  id: WORKER_TAG_MENU_ACTION_ID,
  title: "Move to Projects",
  image: "folder",
};

export function workerTagMenuAction(thread: EnvironmentThreadShell): MenuAction {
  return isWorkerThread(thread.source) ? MOVE_TO_PROJECTS_MENU_ACTION : MOVE_TO_WORKERS_MENU_ACTION;
}

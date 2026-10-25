import type { ScheduledTask } from "@t3tools/contracts";

import type { ThreadStatusPill } from "./Sidebar.logic";

export type LegacySidebarTab = "projects" | "workers";

const FAILED_WORKER_PILL: ThreadStatusPill = {
  label: "Failed",
  colorClass: "text-red-600 dark:text-red-300/90",
  dotClass: "bg-red-500 dark:bg-red-300/90",
  pulse: false,
};

const RUNNING_WORKER_PILL: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-sky-600 dark:text-sky-300/80",
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  pulse: true,
};

export interface WorkerState {
  /** Dot shown in the row's status slot; null keeps a quiet worker blank. */
  readonly pill: ThreadStatusPill | null;
  /** Whether the worker belongs in Projects' "Needs you" group. */
  readonly needsYou: boolean;
}

/**
 * A worker stays quiet unless a run needs the user. Approvals, questions and
 * failures always do; a run that merely completed does not, so a scheduled
 * check that found nothing never lights up the sidebar.
 */
export function resolveWorkerState(input: {
  readonly task: Pick<ScheduledTask, "enabled" | "lastRunStatus" | "lastRunAt">;
  readonly threadPill: ThreadStatusPill | null;
  readonly dismissedRunAt: string | null;
}): WorkerState {
  const { task, threadPill, dismissedRunAt } = input;
  if (threadPill?.label === "Pending Approval" || threadPill?.label === "Awaiting Input") {
    return { pill: threadPill, needsYou: true };
  }
  if (threadPill?.label === "Failed") {
    return { pill: threadPill, needsYou: true };
  }
  if (threadPill?.label === "Working" || threadPill?.label === "Connecting") {
    return { pill: threadPill, needsYou: false };
  }
  if (task.lastRunStatus === "running") {
    return { pill: RUNNING_WORKER_PILL, needsYou: false };
  }
  if (task.lastRunStatus === "failed" && task.lastRunAt !== dismissedRunAt) {
    return { pill: FAILED_WORKER_PILL, needsYou: true };
  }
  return { pill: null, needsYou: false };
}

export interface WorkerProjectGroup<T> {
  readonly projectKey: string;
  readonly workers: readonly T[];
}

/** Groups workers under their projects in sidebar order; unknown projects go last. */
export function groupWorkersByProject<T>(
  workers: readonly T[],
  projectKeyOf: (worker: T) => string,
  projectOrder: readonly string[],
): WorkerProjectGroup<T>[] {
  const byProject = new Map<string, T[]>();
  for (const worker of workers) {
    const key = projectKeyOf(worker);
    const group = byProject.get(key);
    if (group) group.push(worker);
    else byProject.set(key, [worker]);
  }
  const rank = new Map(projectOrder.map((key, index) => [key, index] as const));
  return [...byProject.entries()]
    .toSorted(
      ([left], [right]) =>
        (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([projectKey, groupWorkers]) => ({ projectKey, workers: groupWorkers }));
}

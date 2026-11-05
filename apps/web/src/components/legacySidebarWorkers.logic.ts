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
  /** Its thread is archived and it won't run again, so the Workers tab hides it by default. */
  readonly archived: boolean;
}

/** Whether a worker will still run: on, and either scheduled ahead or waiting for a webhook. */
function isWorkerLive(task: Pick<ScheduledTask, "enabled" | "schedule" | "nextRunAt">) {
  return task.enabled && (task.schedule.type === "webhook" || task.nextRunAt !== null);
}

const QUIET: WorkerState = { pill: null, needsYou: false, archived: false };

/**
 * Quiet unless a run needs the user: approvals, questions and failures do, a completed run doesn't.
 * A worker whose thread is archived can't post anywhere: broken if it would still run, else archived.
 */
export function resolveWorkerState(input: {
  readonly task: Pick<
    ScheduledTask,
    "enabled" | "lastRunStatus" | "lastRunAt" | "schedule" | "nextRunAt"
  >;
  readonly threadClosed: boolean;
  readonly threadPill: ThreadStatusPill | null;
  readonly dismissedRunAt: string | null;
}): WorkerState {
  const { task, threadClosed, threadPill, dismissedRunAt } = input;
  if (threadClosed) {
    return isWorkerLive(task)
      ? { pill: FAILED_WORKER_PILL, needsYou: true, archived: false }
      : { ...QUIET, archived: true };
  }
  if (threadPill?.label === "Pending Approval" || threadPill?.label === "Awaiting Input") {
    return { ...QUIET, pill: threadPill, needsYou: true };
  }
  if (threadPill?.label === "Failed") {
    return { ...QUIET, pill: threadPill, needsYou: true };
  }
  if (threadPill?.label === "Working" || threadPill?.label === "Connecting") {
    return { ...QUIET, pill: threadPill };
  }
  if (task.lastRunStatus === "running") {
    return { ...QUIET, pill: RUNNING_WORKER_PILL };
  }
  if (task.lastRunStatus === "failed" && task.lastRunAt !== dismissedRunAt) {
    return { ...QUIET, pill: FAILED_WORKER_PILL, needsYou: true };
  }
  return QUIET;
}

const ATTENTION_LABELS: ReadonlySet<ThreadStatusPill["label"]> = new Set([
  "Pending Approval",
  "Awaiting Input",
  "Failed",
]);

/** A worker thread asks for the user when it waits on them or fails, or when one of its jobs does. */
export function resolveWorkerThreadState(input: {
  readonly threadPill: ThreadStatusPill | null;
  readonly jobStates: readonly WorkerState[];
}): WorkerState {
  const { threadPill, jobStates } = input;
  if (threadPill && ATTENTION_LABELS.has(threadPill.label)) {
    return { ...QUIET, pill: threadPill, needsYou: true };
  }
  const failing = jobStates.find((state) => state.needsYou);
  if (failing) return { ...failing, archived: false };
  if (threadPill?.label === "Working" || threadPill?.label === "Connecting") {
    return { ...QUIET, pill: threadPill };
  }
  return jobStates.find((state) => state.pill !== null) ?? QUIET;
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

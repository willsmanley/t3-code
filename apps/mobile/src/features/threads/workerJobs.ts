// Fork (F18): the Workers tab's "Jobs in project threads", like the desktop Workers tab's.
import type { ScheduledTask } from "@t3tools/contracts";

import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";

export interface WorkerJobThread {
  readonly title: string;
  readonly archived: boolean;
  readonly worker: boolean;
}

/** The parts of a `ScheduledTask` a job row reads. */
interface JobTask {
  readonly enabled: boolean;
  readonly schedule: { readonly type: string };
  readonly nextRunAt: string | null;
  readonly threadId: string | null;
  readonly lastRunStatus: ScheduledTask["lastRunStatus"];
  readonly updatedAt: string;
}

export interface WorkerJob<T extends JobTask = ScheduledTask> {
  readonly task: T;
  /** The thread it posts into; null when each run starts a new thread or the thread is gone. */
  readonly thread: WorkerJobThread | null;
  readonly status: string;
  readonly failed: boolean;
}

/** Whether a job will still run: on, and either scheduled ahead or waiting for a webhook. */
function isJobLive(task: JobTask) {
  return task.enabled && (task.schedule.type === "webhook" || task.nextRunAt !== null);
}

/**
 * Jobs outside worker threads, newest first. A worker thread's jobs show with that thread. A job
 * whose thread is archived or gone shows only while it would still run, since it can't post.
 */
export function projectThreadJobs<T extends JobTask>(input: {
  readonly tasks: ReadonlyArray<T>;
  readonly threadOf: (task: T) => WorkerJobThread | null;
  readonly nowMs: number;
}): WorkerJob<T>[] {
  return input.tasks
    .flatMap((task): WorkerJob<T>[] => {
      const thread = task.threadId === null ? null : input.threadOf(task);
      if (thread?.worker) return [];
      const closed = task.threadId !== null && (thread === null || thread.archived);
      const live = isJobLive(task);
      if (closed && !live) return [];
      if (closed) return [{ task, thread, status: "Its thread is archived", failed: true }];
      if (task.lastRunStatus === "failed") {
        return [{ task, thread, status: "Last run failed", failed: true }];
      }
      const status =
        task.lastRunStatus === "running"
          ? "Running"
          : !task.enabled
            ? "Off"
            : task.schedule.type === "webhook"
              ? "Runs on webhook"
              : task.nextRunAt !== null
                ? formatNextScheduledTaskRun(task.nextRunAt, input.nowMs)
                : "No run scheduled";
      return [{ task, thread, status, failed: false }];
    })
    .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt));
}

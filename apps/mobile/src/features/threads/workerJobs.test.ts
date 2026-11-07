import { describe, expect, it } from "vite-plus/test";

import { projectThreadJobs, type WorkerJobThread } from "./workerJobs";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

function task(
  id: string,
  overrides: Partial<{
    enabled: boolean;
    nextRunAt: string | null;
    threadId: string | null;
    lastRunStatus: "never" | "running" | "succeeded" | "failed";
    webhook: boolean;
  }> = {},
) {
  return {
    id,
    enabled: overrides.enabled ?? true,
    schedule: { type: overrides.webhook ? "webhook" : "interval" },
    nextRunAt: overrides.nextRunAt === undefined ? null : overrides.nextRunAt,
    threadId: overrides.threadId === undefined ? `thread-${id}` : overrides.threadId,
    lastRunStatus: overrides.lastRunStatus ?? "succeeded",
    updatedAt: `2026-11-0${id.length}T00:00:00.000Z`,
  };
}

describe("projectThreadJobs", () => {
  it("lists jobs outside worker threads, hides dead jobs of closed threads, and labels each", () => {
    const threads = new Map<string, WorkerJobThread>([
      ["thread-a", { title: "Project thread", archived: false, worker: false }],
      ["thread-bb", { title: "Worker", archived: false, worker: true }],
      ["thread-ccc", { title: "Archived", archived: true, worker: false }],
      ["thread-dddd", { title: "Archived, still on", archived: true, worker: false }],
      ["thread-ffffff", { title: "Busy", archived: false, worker: false }],
    ]);
    const jobs = projectThreadJobs({
      tasks: [
        task("a", { lastRunStatus: "failed" }),
        task("bb"),
        task("ccc"),
        task("dddd", { webhook: true }),
        task("eeeee", { threadId: null, enabled: false }),
        task("ffffff", { lastRunStatus: "running" }),
        task("ggggggg", { threadId: "gone" }),
      ],
      threadOf: (job) => (job.threadId === null ? null : (threads.get(job.threadId) ?? null)),
      nowMs: NOW,
    });

    expect(jobs.map((job) => [job.task.id, job.status, job.failed])).toEqual([
      ["ffffff", "Running", false],
      ["eeeee", "Off", false],
      ["dddd", "Its thread is archived", true],
      ["a", "Last run failed", true],
    ]);
  });
});

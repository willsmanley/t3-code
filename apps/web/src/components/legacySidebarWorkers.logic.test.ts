import { describe, expect, it } from "vite-plus/test";

import type { ScheduledTask } from "@t3tools/contracts";

import type { ThreadStatusPill } from "./Sidebar.logic";
import {
  groupWorkersByProject,
  resolveWorkerState,
  resolveWorkerThreadState,
} from "./legacySidebarWorkers.logic";

const pill = (label: ThreadStatusPill["label"]): ThreadStatusPill => ({
  label,
  colorClass: "",
  dotClass: "",
  pulse: false,
});

const task = (
  lastRunStatus: "never" | "running" | "succeeded" | "failed",
  lastRunAt: string | null = "2026-10-24T15:00:00.000Z",
) => ({
  enabled: true,
  lastRunStatus,
  lastRunAt,
  schedule: { type: "interval", everyMs: 3_600_000 } as ScheduledTask["schedule"],
  nextRunAt: "2026-10-24T16:00:00.000Z" as string | null,
});

describe("resolveWorkerState", () => {
  it("keeps a worker quiet when its run completed, even unseen", () => {
    expect(
      resolveWorkerState({
        task: task("succeeded"),
        threadClosed: false,
        threadPill: pill("Completed"),
        dismissedRunAt: null,
      }),
    ).toEqual({ pill: null, needsYou: false, archived: false });
  });

  it("brings questions, approvals and failures to the user", () => {
    for (const label of ["Awaiting Input", "Pending Approval", "Failed"] as const) {
      expect(
        resolveWorkerState({
          task: task("succeeded"),
          threadClosed: false,
          threadPill: pill(label),
          dismissedRunAt: null,
        }).needsYou,
      ).toBe(true);
    }
  });

  it("brings a failed scheduled run to the user until it is marked done", () => {
    const failed = task("failed");
    expect(
      resolveWorkerState({
        task: failed,
        threadClosed: false,
        threadPill: null,
        dismissedRunAt: null,
      }).needsYou,
    ).toBe(true);
    expect(
      resolveWorkerState({
        task: failed,
        threadClosed: false,
        threadPill: null,
        dismissedRunAt: failed.lastRunAt,
      }).needsYou,
    ).toBe(false);
    expect(
      resolveWorkerState({
        task: task("failed", "2026-10-25T15:00:00.000Z"),
        threadClosed: false,
        threadPill: null,
        dismissedRunAt: failed.lastRunAt,
      }).needsYou,
    ).toBe(true);
  });

  it("hides a finished worker whose thread is archived, but flags one that would still run", () => {
    const finished = { ...task("failed"), nextRunAt: null };
    expect(
      resolveWorkerState({
        task: finished,
        threadClosed: true,
        threadPill: null,
        dismissedRunAt: null,
      }),
    ).toEqual({ pill: null, needsYou: false, archived: true });
    expect(
      resolveWorkerState({
        task: { ...task("succeeded"), enabled: false },
        threadClosed: true,
        threadPill: null,
        dismissedRunAt: null,
      }).archived,
    ).toBe(true);
    for (const live of [
      task("succeeded"),
      {
        ...task("never"),
        schedule: { type: "webhook" } as ScheduledTask["schedule"],
        nextRunAt: null,
      },
    ]) {
      const state = resolveWorkerState({
        task: live,
        threadClosed: true,
        threadPill: null,
        dismissedRunAt: live.lastRunAt,
      });
      expect(state.needsYou).toBe(true);
      expect(state.archived).toBe(false);
      expect(state.pill?.label).toBe("Failed");
    }
  });

  it("shows a running worker without asking for attention", () => {
    const state = resolveWorkerState({
      task: task("running"),
      threadClosed: false,
      threadPill: null,
      dismissedRunAt: null,
    });
    expect(state.needsYou).toBe(false);
    expect(state.pill?.label).toBe("Working");
  });
});

describe("resolveWorkerThreadState", () => {
  const quiet = { pill: null, needsYou: false, archived: false };
  const failedJob = { pill: pill("Failed"), needsYou: true, archived: false };
  const runningJob = { pill: pill("Working"), needsYou: false, archived: false };

  it("stays quiet when its runs complete, even unseen", () => {
    expect(resolveWorkerThreadState({ threadPill: pill("Completed"), jobStates: [quiet] })).toEqual(
      quiet,
    );
  });

  it("asks for the user when the thread waits on them or fails, or a job fails", () => {
    for (const label of ["Awaiting Input", "Pending Approval", "Failed"] as const) {
      expect(resolveWorkerThreadState({ threadPill: pill(label), jobStates: [] }).needsYou).toBe(
        true,
      );
    }
    expect(resolveWorkerThreadState({ threadPill: null, jobStates: [quiet, failedJob] })).toEqual(
      failedJob,
    );
  });

  it("shows work in progress without asking for attention", () => {
    expect(
      resolveWorkerThreadState({ threadPill: pill("Working"), jobStates: [] }).pill?.label,
    ).toBe("Working");
    expect(resolveWorkerThreadState({ threadPill: null, jobStates: [runningJob] })).toEqual(
      runningJob,
    );
  });
});

describe("groupWorkersByProject", () => {
  it("follows sidebar project order and puts unknown projects last", () => {
    const groups = groupWorkersByProject(
      [
        { id: "a", project: "unknown" },
        { id: "b", project: "personal" },
        { id: "c", project: "code" },
        { id: "d", project: "personal" },
      ],
      (worker) => worker.project,
      ["code", "personal"],
    );
    expect(groups.map((group) => [group.projectKey, group.workers.map((w) => w.id)])).toEqual([
      ["code", ["c"]],
      ["personal", ["b", "d"]],
      ["unknown", ["a"]],
    ]);
  });
});

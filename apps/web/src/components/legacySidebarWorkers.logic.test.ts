import { describe, expect, it } from "vite-plus/test";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { groupWorkersByProject, resolveWorkerState } from "./legacySidebarWorkers.logic";

const pill = (label: ThreadStatusPill["label"]): ThreadStatusPill => ({
  label,
  colorClass: "",
  dotClass: "",
  pulse: false,
});

const task = (
  lastRunStatus: "never" | "running" | "succeeded" | "failed",
  lastRunAt: string | null = "2026-10-24T15:00:00.000Z",
) => ({ enabled: true, lastRunStatus, lastRunAt });

describe("resolveWorkerState", () => {
  it("keeps a worker quiet when its run completed, even unseen", () => {
    expect(
      resolveWorkerState({
        task: task("succeeded"),
        threadPill: pill("Completed"),
        dismissedRunAt: null,
      }),
    ).toEqual({ pill: null, needsYou: false });
  });

  it("brings questions, approvals and failures to the user", () => {
    for (const label of ["Awaiting Input", "Pending Approval", "Failed"] as const) {
      expect(
        resolveWorkerState({
          task: task("succeeded"),
          threadPill: pill(label),
          dismissedRunAt: null,
        }).needsYou,
      ).toBe(true);
    }
  });

  it("brings a failed scheduled run to the user until it is marked done", () => {
    const failed = task("failed");
    expect(
      resolveWorkerState({ task: failed, threadPill: null, dismissedRunAt: null }).needsYou,
    ).toBe(true);
    expect(
      resolveWorkerState({ task: failed, threadPill: null, dismissedRunAt: failed.lastRunAt })
        .needsYou,
    ).toBe(false);
    expect(
      resolveWorkerState({
        task: task("failed", "2026-10-25T15:00:00.000Z"),
        threadPill: null,
        dismissedRunAt: failed.lastRunAt,
      }).needsYou,
    ).toBe(true);
  });

  it("shows a running worker without asking for attention", () => {
    const state = resolveWorkerState({
      task: task("running"),
      threadPill: null,
      dismissedRunAt: null,
    });
    expect(state.needsYou).toBe(false);
    expect(state.pill?.label).toBe("Working");
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

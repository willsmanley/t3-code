import { describe, expect, it, vi } from "vite-plus/test";

import {
  archiveSelectedThreadEntries,
  resolveProjectStatusIndicator,
  sortProjectsForSidebar,
} from "./LegacySidebar.logic";

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("ranks waiting below active work and above plan-ready", () => {
    const waiting = {
      label: "Waiting" as const,
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };

    expect(
      resolveProjectStatusIndicator([
        waiting,
        { label: "Working", colorClass: "text-sky-600", dotClass: "bg-sky-500", pulse: true },
      ]),
    ).toMatchObject({ label: "Working" });
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
        waiting,
      ]),
    ).toMatchObject({ label: "Waiting" });
  });
});

describe("sortProjectsForSidebar", () => {
  const older = { id: "project-1", title: "Older", createdAt: "2026-03-01T00:00:00.000Z" };
  const newer = { id: "project-2", title: "Newer", createdAt: "2026-03-09T00:00:00.000Z" };

  it("keeps the manual order and returns the same project objects", () => {
    const sorted = sortProjectsForSidebar([older, newer], [], "manual");
    expect(sorted).toEqual([older, newer]);
    expect(sorted[0]).toBe(older);
  });

  it("puts the newest project first when sorting by creation time", () => {
    expect(sortProjectsForSidebar([older, newer], [], "created_at")).toEqual([newer, older]);
  });
});

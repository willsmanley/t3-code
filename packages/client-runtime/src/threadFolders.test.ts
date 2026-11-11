import { EnvironmentId, ProjectId, type ThreadFolderSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseFolderThreadProject,
  deviceFolderMigrationStep,
  findNewThreadProject,
  folderNameForProject,
  folderNameProblem,
  groupByFolder,
  moveFolder,
  orderFolders,
  planFolderPerProject,
  renameFolderInList,
  resolveNewThreadProject,
  resolveThreadFolderView,
} from "./threadFolders.ts";

describe("folderNameProblem", () => {
  it("accepts a trimmed single line that fits in a thread tag with its prefix", () => {
    expect(folderNameProblem("  Research  ")).toBeNull();
    expect(folderNameProblem("x".repeat(56))).toBeNull();
    expect(folderNameProblem("   ")).toBe("Enter a folder name.");
    expect(folderNameProblem("x".repeat(57))).toBe("Folder names can be at most 56 characters.");
    expect(folderNameProblem("two\nlines")).toBe("A folder name must be a single line.");
  });
});

describe("orderFolders and groupByFolder", () => {
  it("keeps the user's order, adds folders known only from threads by name, and files the rest", () => {
    const order = orderFolders(["B", "A", "B"], ["Z", "A", "C"]);
    expect(order).toEqual(["B", "A", "C", "Z"]);
    const threads = [
      { id: 1, folder: "A" },
      { id: 2, folder: null },
      { id: 3, folder: "Z" },
      { id: 4, folder: "A" },
      { id: 5, folder: "Elsewhere" },
    ];
    const grouped = groupByFolder(threads, (thread) => thread.folder, order);
    expect(grouped.folders.map((group) => [group.folder, group.threads.map((t) => t.id)])).toEqual([
      ["B", []],
      ["A", [1, 4]],
      ["C", []],
      ["Z", [3]],
      ["Elsewhere", [5]],
    ]);
    expect(grouped.unfiled.map((thread) => thread.id)).toEqual([2]);
  });
});

describe("moveFolder and renameFolderInList", () => {
  it("moves a dragged folder to the slot of the one it lands on", () => {
    expect(moveFolder(["A", "B", "C", "D"], "A", "C")).toEqual(["B", "C", "A", "D"]);
    expect(moveFolder(["A", "B", "C", "D"], "D", "B")).toEqual(["A", "D", "B", "C"]);
    expect(moveFolder(["A", "B"], "A", "missing")).toEqual(["A", "B"]);
  });

  it("renames in place, and merges into a folder that already has the new name", () => {
    expect(renameFolderInList(["A", "B", "C"], "B", "X")).toEqual(["A", "X", "C"]);
    expect(renameFolderInList(["A", "B", "C"], "B", "C")).toEqual(["A", "C"]);
  });
});

describe("planFolderPerProject", () => {
  it("makes a folder per project in order and files each thread under its project", () => {
    const plan = planFolderPerProject({
      projects: [
        { displayName: "t3code", archived: false, projectKeys: ["env:p1", "env2:p1"] },
        { displayName: "Empty", archived: false, projectKeys: ["env:p2"] },
        { displayName: "Old", archived: true, projectKeys: ["env:p3"] },
        { displayName: "Gone", archived: true, projectKeys: ["env:p4"] },
        { displayName: " t3code ", archived: false, projectKeys: ["env:p5"] },
        { displayName: `Line\nbreak ${"y".repeat(80)}`, archived: false, projectKeys: ["env:p6"] },
      ],
      threads: [
        { id: "a", project: "env2:p1" },
        { id: "b", project: "env:p3" },
        { id: "c", project: "env:p5" },
        { id: "d", project: "env:unknown" },
      ],
      projectKeyOf: (thread) => thread.project,
    });
    const longName = folderNameForProject(`Line\nbreak ${"y".repeat(80)}`);
    expect(longName).toBe(`Line break ${"y".repeat(45)}`);
    expect(plan.folders).toEqual(["t3code", "Empty", "Old", longName]);
    expect(plan.assignments.map(({ thread, folder }) => [thread.id, folder])).toEqual([
      ["a", "t3code"],
      ["b", "Old"],
      ["c", "t3code"],
    ]);
  });
});

describe("chooseFolderThreadProject", () => {
  it("uses the project of the folder's most recently active thread, then the fallbacks", () => {
    expect(
      chooseFolderThreadProject({
        folderThreads: [
          { project: "older", activeAt: "2026-11-01T10:00:00.000Z" },
          { project: "newest", activeAt: "2026-11-05T10:00:00.000Z" },
          { project: "broken", activeAt: "not a date" },
        ],
        current: "current",
        first: "first",
      }),
    ).toBe("newest");
    expect(
      chooseFolderThreadProject({ folderThreads: [], current: "current", first: "first" }),
    ).toBe("current");
    expect(chooseFolderThreadProject({ folderThreads: [], current: null, first: "first" })).toBe(
      "first",
    );
  });
});

const serverSettings = (
  folders: ReadonlyArray<readonly [string, boolean]>,
  extra: Partial<ThreadFolderSettings> = {},
): ThreadFolderSettings => ({
  folders: folders.map(([name, collapsed]) => ({ name, collapsed })),
  defaultFolder: null,
  unfiledCollapsed: false,
  newThreadProjectId: null,
  autoFile: true,
  updatedAt: null,
  ...extra,
});

describe("resolveThreadFolderView", () => {
  const session = { folders: ["Mine"], collapsed: ["Mine"], unfiledCollapsed: true };

  it("leads with the server changed most recently and adds the others' folders", () => {
    const view = resolveThreadFolderView({
      servers: [
        serverSettings([["Seeded", true]]),
        serverSettings(
          [
            ["Work", false],
            ["Todo", true],
          ],
          {
            updatedAt: "2026-11-10T00:00:00.000Z",
            defaultFolder: "Work",
          },
        ),
        serverSettings(
          [
            ["Todo", false],
            ["School", true],
          ],
          {
            updatedAt: "2026-11-11T00:00:00.000Z",
            defaultFolder: "Todo",
            unfiledCollapsed: true,
          },
        ),
      ],
      fromThreads: ["Zed", "Work", "Alpha"],
      session,
    });
    expect(view).toEqual({
      folders: ["Todo", "School", "Work", "Seeded", "Alpha", "Zed"],
      collapsed: new Set(["School", "Seeded"]),
      unfiledCollapsed: true,
      defaultFolder: "Todo",
      autoFile: true,
      serverBacked: true,
    });
  });

  it("uses this session's list when no server keeps folders", () => {
    expect(resolveThreadFolderView({ servers: [], fromThreads: ["Work"], session })).toEqual({
      folders: ["Mine", "Work"],
      collapsed: new Set(["Mine"]),
      unfiledCollapsed: true,
      defaultFolder: null,
      autoFile: false,
      serverBacked: false,
    });
  });
});

describe("resolveNewThreadProject", () => {
  const hostkey = EnvironmentId.make("hostkey");
  const laptop = EnvironmentId.make("laptop");
  const agents = ProjectId.make("project:agents");
  const local = ProjectId.make("project:local");

  it("takes the most recently changed server that names a project, and only a live one", () => {
    expect(resolveNewThreadProject(new Map([[hostkey, serverSettings([])]]))).toBeNull();
    const ref = resolveNewThreadProject(
      new Map([
        [
          hostkey,
          serverSettings([], { newThreadProjectId: agents, updatedAt: "2026-11-11T00:00:00.000Z" }),
        ],
        [
          laptop,
          serverSettings([], { newThreadProjectId: local, updatedAt: "2026-11-10T00:00:00.000Z" }),
        ],
      ]),
    );
    expect(ref).toEqual({ environmentId: hostkey, projectId: agents });
    const project = { environmentId: hostkey, id: agents, archivedAt: null };
    expect(findNewThreadProject(ref, [project])).toBe(project);
    expect(findNewThreadProject(ref, [{ ...project, archivedAt: "2026-11-11" }])).toBeNull();
    expect(findNewThreadProject(ref, [{ ...project, environmentId: laptop }])).toBeNull();
  });
});

describe("deviceFolderMigrationStep", () => {
  const hostkey = EnvironmentId.make("hostkey");
  const laptop = EnvironmentId.make("laptop");
  const device = {
    folders: ["Todo", "Todo", " ", "School"],
    collapsed: ["School"],
    unfiledCollapsed: false,
  };

  it("waits until every server that keeps folders has sent them", () => {
    expect(deviceFolderMigrationStep({ device, environmentIds: [], settings: new Map() })).toEqual({
      type: "wait",
    });
    expect(
      deviceFolderMigrationStep({
        device,
        environmentIds: [hostkey, laptop],
        settings: new Map([[hostkey, serverSettings([])]]),
      }),
    ).toEqual({ type: "wait" });
  });

  it("sends the saved order to every server while none has a user change", () => {
    expect(
      deviceFolderMigrationStep({
        device,
        environmentIds: [hostkey, laptop],
        settings: new Map([
          [hostkey, serverSettings([["Work", false]])],
          [laptop, serverSettings([])],
        ]),
      }),
    ).toEqual({
      type: "push",
      environmentIds: [hostkey, laptop],
      update: {
        _tag: "seedFromDevice",
        order: ["Todo", "School"],
        collapsed: ["School"],
        unfiledCollapsed: false,
      },
    });
  });

  it("drops the saved order once a server has a user change, or when it is empty", () => {
    expect(
      deviceFolderMigrationStep({
        device,
        environmentIds: [hostkey],
        settings: new Map([
          [hostkey, serverSettings([], { updatedAt: "2026-11-11T00:00:00.000Z" })],
        ]),
      }),
    ).toEqual({ type: "forget" });
    expect(
      deviceFolderMigrationStep({
        device: { folders: [], collapsed: [], unfiledCollapsed: false },
        environmentIds: [hostkey],
        settings: new Map([[hostkey, serverSettings([])]]),
      }),
    ).toEqual({ type: "forget" });
  });
});

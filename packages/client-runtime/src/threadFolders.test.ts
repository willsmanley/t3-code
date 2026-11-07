import { describe, expect, it } from "vite-plus/test";

import {
  chooseFolderThreadProject,
  folderNameForProject,
  folderNameProblem,
  folderOfTags,
  groupByFolder,
  moveFolder,
  orderFolders,
  planFolderPerProject,
  planFolderTagChange,
  renameFolderInList,
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

describe("folderOfTags", () => {
  it("reads the newest folder tag and ignores other tags and empty names", () => {
    expect(folderOfTags(undefined)).toBeNull();
    expect(folderOfTags(["worker", "folder:", "folderish"])).toBeNull();
    expect(folderOfTags(["folder:Old", "worker", "folder:New"])).toBe("New");
    expect(folderOfTags(["folder: Spaced "])).toBe("Spaced");
  });
});

describe("planFolderTagChange", () => {
  it("adds the new folder tag and removes every other folder tag", () => {
    expect(planFolderTagChange(["worker", "folder:A", "folder: B"], "C")).toEqual({
      add: "folder:C",
      remove: ["folder:A", "folder: B"],
    });
  });

  it("keeps a folder tag the thread already has and only clears the rest", () => {
    expect(planFolderTagChange(["folder:A", "folder:B"], "A")).toEqual({
      add: null,
      remove: ["folder:B"],
    });
    expect(planFolderTagChange(["folder:A"], "A")).toEqual({ add: null, remove: [] });
  });

  it("removes every folder tag when moving to no folder", () => {
    expect(planFolderTagChange(["folder:A", "worker"], null)).toEqual({
      add: null,
      remove: ["folder:A"],
    });
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

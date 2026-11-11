import { describe, expect, it } from "@effect/vitest";

import { ProjectId } from "./baseSchemas.ts";
import {
  applyThreadFolderUpdate,
  planThreadFolderTagChange,
  type ThreadFolderSettings as Settings,
  type ThreadFolderUpdateInput,
  threadFolderOfTags,
} from "./threadFolders.ts";

const NOW = "2026-11-11T12:00:00.000Z";
const settings = (
  folders: ReadonlyArray<readonly [string, boolean]>,
  extra: Partial<Settings> = {},
): Settings => ({
  folders: folders.map(([name, collapsed]) => ({ name, collapsed })),
  defaultFolder: null,
  unfiledCollapsed: false,
  newThreadProjectId: null,
  autoFile: true,
  updatedAt: null,
  ...extra,
});

describe("threadFolderOfTags", () => {
  it("reads the newest folder tag and ignores other tags and empty names", () => {
    expect(threadFolderOfTags(undefined)).toBeNull();
    expect(threadFolderOfTags(["worker", "folder:", "folderish"])).toBeNull();
    expect(threadFolderOfTags(["folder:Old", "worker", "folder:New"])).toBe("New");
    expect(threadFolderOfTags(["folder: Spaced "])).toBe("Spaced");
  });
});

describe("planThreadFolderTagChange", () => {
  it("adds the new folder tag and removes every other folder tag", () => {
    expect(planThreadFolderTagChange(["worker", "folder:A", "folder: B"], "C")).toEqual({
      add: "folder:C",
      remove: ["folder:A", "folder: B"],
    });
  });

  it("keeps a folder tag the thread already has and only clears the rest", () => {
    expect(planThreadFolderTagChange(["folder:A", "folder:B"], "A")).toEqual({
      add: null,
      remove: ["folder:B"],
    });
    expect(planThreadFolderTagChange(["folder:A"], "A")).toEqual({ add: null, remove: [] });
  });

  it("removes every folder tag when moving to no folder", () => {
    expect(planThreadFolderTagChange(["folder:A", "worker"], null)).toEqual({
      add: null,
      remove: ["folder:A"],
    });
  });
});

it("applies folder updates", () => {
  const base = settings(
    [
      ["Todo", false],
      ["School", true],
      ["Work", false],
    ],
    {
      defaultFolder: "Todo",
    },
  );
  const cases: ReadonlyArray<readonly [string, Settings, ThreadFolderUpdateInput, Settings]> = [
    [
      "create skips names already listed",
      base,
      { _tag: "create", names: ["Work", "Ideas", "Ideas"] },
      { ...base, folders: [...base.folders, { name: "Ideas", collapsed: false }], updatedAt: NOW },
    ],
    [
      "rename keeps place and collapse, and the default follows",
      base,
      { _tag: "rename", from: "Todo", to: "Today" },
      settings(
        [
          ["Today", false],
          ["School", true],
          ["Work", false],
        ],
        {
          defaultFolder: "Today",
          updatedAt: NOW,
        },
      ),
    ],
    [
      "rename onto a listed folder merges into it",
      base,
      { _tag: "rename", from: "Work", to: "School" },
      settings(
        [
          ["Todo", false],
          ["School", true],
        ],
        { defaultFolder: "Todo", updatedAt: NOW },
      ),
    ],
    [
      "delete drops the folder and the default",
      base,
      { _tag: "delete", name: "Todo" },
      settings(
        [
          ["School", true],
          ["Work", false],
        ],
        { updatedAt: NOW },
      ),
    ],
    [
      "reorder adds folders only threads knew and keeps unnamed ones last",
      base,
      { _tag: "reorder", order: ["Work", "Tagged", "Todo"] },
      settings(
        [
          ["Work", false],
          ["Tagged", false],
          ["Todo", false],
          ["School", true],
        ],
        {
          defaultFolder: "Todo",
          updatedAt: NOW,
        },
      ),
    ],
    [
      "collapsing a folder threads knew lists it",
      base,
      { _tag: "setCollapsed", name: "Tagged", collapsed: true },
      { ...base, folders: [...base.folders, { name: "Tagged", collapsed: true }], updatedAt: NOW },
    ],
    [
      "Unfiled collapses",
      base,
      { _tag: "setCollapsed", name: null, collapsed: true },
      { ...base, unfiledCollapsed: true, updatedAt: NOW },
    ],
    [
      "default can be cleared",
      base,
      { _tag: "setDefault", name: null },
      { ...base, defaultFolder: null, updatedAt: NOW },
    ],
    [
      "the new-thread project is set and cleared",
      base,
      { _tag: "setNewThreadProject", projectId: ProjectId.make("project:agents") },
      { ...base, newThreadProjectId: ProjectId.make("project:agents"), updatedAt: NOW },
    ],
    [
      "auto-filing turns off, and setting it again changes nothing",
      { ...base, autoFile: false },
      { _tag: "setAutoFile", enabled: false },
      { ...base, autoFile: false },
    ],
    [
      "a device's saved order replaces the seeded order",
      settings([
        ["Work", false],
        ["Todo", false],
      ]),
      {
        _tag: "seedFromDevice",
        order: ["Todo", "Empty"],
        collapsed: ["Empty"],
        unfiledCollapsed: true,
      },
      settings(
        [
          ["Todo", false],
          ["Empty", true],
          ["Work", false],
        ],
        {
          unfiledCollapsed: true,
          updatedAt: NOW,
        },
      ),
    ],
    [
      "a device's saved order is ignored once anyone changed the list",
      { ...base, updatedAt: "2026-11-10T00:00:00.000Z" },
      { _tag: "seedFromDevice", order: ["Work"], collapsed: [], unfiledCollapsed: true },
      { ...base, updatedAt: "2026-11-10T00:00:00.000Z" },
    ],
  ];
  for (const [name, before, input, after] of cases) {
    expect(applyThreadFolderUpdate(before, input, NOW), name).toEqual(after);
  }
});

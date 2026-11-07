import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  buildFolderThreadTreeListItems,
  moveFolderNextTo,
  PROJECT_THREAD_TREE_PREVIEW_COUNT,
} from "./projectThreadTree";
import { folderGroupKey } from "./threadFolderListItems";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  type ThreadListV2ListItem,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");
const api = ProjectId.make("api");
const web = ProjectId.make("web");
const NOW = "2026-06-02T12:00:00.000Z";
const BASE_MS = Date.parse(NOW);

function makeThread(
  id: string,
  folder: string | null,
  minutesAgo: number,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const at = new Date(BASE_MS - minutesAgo * 60_000).toISOString();
  const thread = makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId: api,
    title: id,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    ...overrides,
  });
  return folder === null
    ? thread
    : { ...thread, source: { ...thread.source, tags: [`folder:${folder}`] } };
}

function buildTree(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly folderOrder?: ReadonlyArray<string>;
    readonly collapsed?: ReadonlyArray<string | null>;
    readonly expanded?: ReadonlyArray<string | null>;
    readonly showEmptyFolders?: boolean;
    readonly selectedThreadKey?: string;
    readonly snoozedShelfExpanded?: boolean;
  } = {},
): ThreadListV2ListItem[] {
  const snoozedShelfExpanded = options.snoozedShelfExpanded ?? true;
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now: NOW,
    snoozedShelfExpanded,
    settledShelfExpanded: true,
  });
  return buildFolderThreadTreeListItems({
    listItems: buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      snoozedCount: layout.snoozedCount,
      snoozedShelfExpanded,
      snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
      settledCount: layout.settledCount,
      settledShelfExpanded: true,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    }),
    folderOrder: options.folderOrder ?? [],
    collapsedGroupKeys: new Set((options.collapsed ?? []).map(folderGroupKey)),
    expandedGroupKeys: new Set((options.expanded ?? []).map(folderGroupKey)),
    showEmptyFolders: options.showEmptyFolders ?? true,
    selectedThreadKey: options.selectedThreadKey,
  });
}

function outline(items: ReadonlyArray<ThreadListV2ListItem>): string[] {
  return items.map((item) => {
    switch (item.type) {
      case "v2-folder":
        return `# ${item.folder ?? "Unfiled"}${item.collapsed ? ` (${item.threadCount})` : ""}`;
      case "v2-folder-more":
        return item.expanded ? "less" : `more ${item.hiddenCount}`;
      case "v2-thread":
        return item.item.thread.title;
      default:
        return item.type;
    }
  });
}

describe("buildFolderThreadTreeListItems", () => {
  it("groups threads by folder in the given order, then Unfiled, most recently active first", () => {
    const items = buildTree(
      [
        makeThread("api-old", "API", 30),
        makeThread("loose", null, 2),
        makeThread("web-new", "Web", 1),
        makeThread("api-settled", "API", 5, { settledOverride: "settled" }),
        makeThread("web-old", "Web", 60),
      ],
      { folderOrder: ["API", "Web"] },
    );

    expect(outline(items)).toEqual([
      "# API",
      "api-settled",
      "api-old",
      "# Web",
      "web-new",
      "web-old",
      "# Unfiled",
      "loose",
    ]);
  });

  it("lists a folder it was not given after the ordered ones, and empty folders on request", () => {
    const threads = [makeThread("tagged", "Elsewhere", 1), makeThread("loose", null, 2)];

    expect(outline(buildTree(threads, { folderOrder: ["Empty"] }))).toEqual([
      "# Empty",
      "# Elsewhere",
      "tagged",
      "# Unfiled",
      "loose",
    ]);
    expect(
      outline(buildTree(threads, { folderOrder: ["Empty"], showEmptyFolders: false })),
    ).toEqual(["# Elsewhere", "tagged", "# Unfiled", "loose"]);
    expect(outline(buildTree([threads[0]!], { showEmptyFolders: false }))).toEqual([
      "# Elsewhere",
      "tagged",
    ]);
    expect(buildTree([], { folderOrder: ["Empty"], showEmptyFolders: false })).toEqual([]);
  });

  it("moves snoozed threads out of their folders to a Snoozed section after them", () => {
    const wakeAt = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString();
    const threads = [
      makeThread("api-active", "API", 10),
      makeThread("api-snoozed", "API", 5, { snoozedUntil: wakeAt(60) }),
      makeThread("web-snoozed", null, 1, { snoozedUntil: wakeAt(120) }),
    ];

    expect(
      outline(buildTree(threads, { folderOrder: ["API"], snoozedShelfExpanded: false })),
    ).toEqual(["# API", "api-active", "# Unfiled", "v2-snoozed-shelf"]);
    expect(outline(buildTree(threads, { folderOrder: ["API"] }))).toEqual([
      "# API",
      "api-active",
      "# Unfiled",
      "v2-snoozed-shelf",
      "api-snoozed",
      "web-snoozed",
    ]);
  });

  it("gives folder headers their neighbours for Move up and Move down, and Unfiled none", () => {
    const items = buildTree([makeThread("a", "A", 30), makeThread("b", "B", 1)], {
      folderOrder: ["A", "B"],
    });
    const headers = items.flatMap((item) =>
      item.type === "v2-folder"
        ? [[item.previousFolder, item.folder, item.nextFolder, item.canArrange]]
        : [],
    );

    expect(headers).toEqual([
      [null, "A", "B", true],
      ["A", "B", null, true],
      [null, null, null, true],
    ]);
  });

  it("offers a folder per project on Unfiled only until a folder exists", () => {
    const offers = (folderOrder: ReadonlyArray<string>) =>
      buildTree([makeThread("loose", null, 1)], { folderOrder }).flatMap((item) =>
        item.type === "v2-folder" ? [[item.folder, item.offerFolderPerProject]] : [],
      );

    expect(offers([])).toEqual([[null, true]]);
    expect(offers(["A"])).toEqual([
      ["A", false],
      [null, false],
    ]);
  });

  it("keeps pinned threads at the top of their folder", () => {
    const items = buildTree([
      makeThread("recent", null, 1),
      makeThread("pinned", null, 90, { pinnedAt: NOW, pinOrderKey: "a0" }),
    ]);

    expect(outline(items)).toEqual(["# Unfiled", "pinned", "recent"]);
  });

  it("previews a long folder, and keeps the selected thread visible", () => {
    const threads = Array.from({ length: PROJECT_THREAD_TREE_PREVIEW_COUNT + 3 }, (_, index) =>
      makeThread(`t${index}`, "API", index),
    );

    const preview = buildTree(threads, {
      folderOrder: ["API"],
      selectedThreadKey: `${environmentId}:t${PROJECT_THREAD_TREE_PREVIEW_COUNT + 2}`,
    });
    expect(outline(preview)).toEqual([
      "# API",
      ...threads.slice(0, PROJECT_THREAD_TREE_PREVIEW_COUNT).map((thread) => thread.title),
      `t${PROJECT_THREAD_TREE_PREVIEW_COUNT + 2}`,
      "more 2",
      "# Unfiled",
    ]);

    const expanded = buildTree(threads, { folderOrder: ["API"], expanded: ["API"] });
    expect(outline(expanded)).toEqual([
      "# API",
      ...threads.map((thread) => thread.title),
      "less",
      "# Unfiled",
    ]);
  });

  it("hides a collapsed folder's threads but the open one, and shows its most urgent status", () => {
    const threads = [
      makeThread("needs-input", "API", 10, { hasPendingUserInput: true }),
      makeThread("needs-approval", "API", 20, { hasPendingApprovals: true }),
      makeThread("loose", null, 1),
    ];
    const items = buildTree(threads, { folderOrder: ["API"], collapsed: ["API", null] });

    expect(outline(items)).toEqual(["# API (2)", "# Unfiled (1)"]);
    const header = items.find((item) => item.type === "v2-folder" && item.folder === "API");
    expect(header?.type === "v2-folder" ? header.status : undefined).toBe("approval");

    const selected = buildTree(threads, {
      folderOrder: ["API"],
      collapsed: ["API"],
      selectedThreadKey: `${environmentId}:needs-input`,
    });
    expect(outline(selected)).toEqual(["# API (2)", "needs-input", "# Unfiled", "loose"]);
  });

  it("starts new threads in the project of the folder's most recently active thread", () => {
    const items = buildTree(
      [makeThread("older", "Mixed", 30), makeThread("newer", "Mixed", 2, { projectId: web })],
      { folderOrder: ["Mixed"] },
    );

    expect(
      items.flatMap((item) =>
        item.type === "v2-folder" ? [[item.folder, item.newThreadProjectKey]] : [],
      ),
    ).toEqual([
      ["Mixed", `${environmentId}:${web}`],
      [null, null],
    ]);
  });

  it("shows the compact time on rows that also show a status", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(BASE_MS);
    const items = buildTree([makeThread("working", null, 5, { hasPendingUserInput: true })]);
    const row = items.find((item) => item.type === "v2-thread");

    expect(row?.type === "v2-thread" ? row.timeLabel : undefined).toBe("5m");
  });
});

describe("moveFolderNextTo", () => {
  it("moves a folder before or after another", () => {
    const order = ["a", "b", "c", "d"];

    expect(moveFolderNextTo(order, "c", { target: "a", placement: "before" })).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(moveFolderNextTo(order, "a", { target: "c", placement: "after" })).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("leaves the order alone for an unknown folder or target", () => {
    expect(moveFolderNextTo(["a", "b"], "x", { target: "a", placement: "before" })).toEqual([
      "a",
      "b",
    ]);
    expect(moveFolderNextTo(["a", "b"], "a", { target: "x", placement: "after" })).toEqual([
      "a",
      "b",
    ]);
  });
});

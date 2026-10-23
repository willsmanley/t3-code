import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  applyProjectMove,
  buildProjectThreadTreeListItems,
  mergeProjectOrder,
  PROJECT_THREAD_TREE_PREVIEW_COUNT,
} from "./projectThreadTree";
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
  projectId: ProjectId,
  minutesAgo: number,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const at = new Date(BASE_MS - minutesAgo * 60_000).toISOString();
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: id,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    ...overrides,
  });
}

const projectGroups = new Map([
  [`${environmentId}:${api}`, { key: "group:api", title: "API" }],
  [`${environmentId}:${web}`, { key: "group:web", title: "Web" }],
]);

function buildTree(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly collapsed?: ReadonlyArray<string>;
    readonly expanded?: ReadonlyArray<string>;
    readonly selectedThreadKey?: string;
    readonly groups?: typeof projectGroups;
    readonly projectOrder?: ReadonlyArray<string>;
  } = {},
): ThreadListV2ListItem[] {
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now: NOW,
    snoozedShelfExpanded: true,
    settledShelfExpanded: true,
  });
  return buildProjectThreadTreeListItems({
    listItems: buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      snoozedCount: layout.snoozedCount,
      snoozedShelfExpanded: true,
      snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
      settledCount: layout.settledCount,
      settledShelfExpanded: true,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    }),
    projectGroups: options.groups ?? projectGroups,
    collapsedProjectKeys: new Set(options.collapsed ?? []),
    expandedProjectKeys: new Set(options.expanded ?? []),
    projectOrder: options.projectOrder,
    selectedThreadKey: options.selectedThreadKey,
  });
}

function outline(items: ReadonlyArray<ThreadListV2ListItem>): string[] {
  return items.map((item) => {
    switch (item.type) {
      case "v2-project":
        return `# ${item.title}${item.collapsed ? ` (${item.threadCount})` : ""}`;
      case "v2-project-more":
        return item.expanded ? "less" : `more ${item.hiddenCount}`;
      case "v2-thread":
        return item.item.thread.title;
      default:
        return item.type;
    }
  });
}

describe("buildProjectThreadTreeListItems", () => {
  it("groups threads under projects, most recently active first, without shelves", () => {
    const items = buildTree([
      makeThread("api-old", api, 30),
      makeThread("web-new", web, 1),
      makeThread("api-settled", api, 5, { settledOverride: "settled" }),
      makeThread("web-old", web, 60),
    ]);

    expect(outline(items)).toEqual([
      "# Web",
      "web-new",
      "web-old",
      "# API",
      "api-settled",
      "api-old",
    ]);
  });

  it("keeps the arranged project order whatever was active last", () => {
    const threads = [makeThread("api-old", api, 30), makeThread("web-new", web, 1)];

    expect(outline(buildTree(threads, { projectOrder: ["group:api", "group:web"] }))).toEqual([
      "# API",
      "api-old",
      "# Web",
      "web-new",
    ]);
  });

  it("puts a project the order has not listed yet above the arranged ones", () => {
    const items = buildTree([makeThread("api", api, 30), makeThread("web", web, 60)], {
      projectOrder: ["group:api"],
    });

    expect(outline(items)).toEqual(["# Web", "web", "# API", "api"]);
  });

  it("gives each project header its neighbours for Move up and Move down", () => {
    const items = buildTree([makeThread("api", api, 30), makeThread("web", web, 1)]);
    const headers = items.flatMap((item) =>
      item.type === "v2-project"
        ? [[item.previousProjectKey, item.projectKey, item.nextProjectKey]]
        : [],
    );

    expect(headers).toEqual([
      [null, "group:web", "group:api"],
      ["group:web", "group:api", null],
    ]);
  });

  it("keeps pinned threads at the top of their project", () => {
    const items = buildTree([
      makeThread("recent", api, 1),
      makeThread("pinned", api, 90, { pinnedAt: NOW, pinOrderKey: "a0" }),
    ]);

    expect(outline(items)).toEqual(["# API", "pinned", "recent"]);
  });

  it("previews a long project, and keeps the selected thread visible", () => {
    const threads = Array.from({ length: PROJECT_THREAD_TREE_PREVIEW_COUNT + 3 }, (_, index) =>
      makeThread(`t${index}`, api, index),
    );

    const preview = buildTree(threads, {
      selectedThreadKey: `${environmentId}:t${PROJECT_THREAD_TREE_PREVIEW_COUNT + 2}`,
    });
    expect(outline(preview)).toEqual([
      "# API",
      ...threads.slice(0, PROJECT_THREAD_TREE_PREVIEW_COUNT).map((thread) => thread.title),
      `t${PROJECT_THREAD_TREE_PREVIEW_COUNT + 2}`,
      "more 2",
    ]);

    const expanded = buildTree(threads, { expanded: ["group:api"] });
    expect(outline(expanded)).toEqual(["# API", ...threads.map((thread) => thread.title), "less"]);
  });

  it("hides a collapsed project's threads and shows its most urgent status", () => {
    const items = buildTree(
      [
        makeThread("needs-input", api, 10, { hasPendingUserInput: true }),
        makeThread("needs-approval", api, 20, { hasPendingApprovals: true }),
        makeThread("web", web, 1),
      ],
      { collapsed: ["group:api"] },
    );

    expect(outline(items)).toEqual(["# Web", "web", "# API (2)"]);
    const header = items.find(
      (item) => item.type === "v2-project" && item.projectKey === "group:api",
    );
    expect(header?.type === "v2-project" ? header.status : undefined).toBe("approval");
  });

  it("starts new threads in the project's most recently active environment", () => {
    const laptop = EnvironmentId.make("environment-2");
    const groups = new Map([
      ...projectGroups,
      [`${laptop}:${api}`, { key: "group:api", title: "API" }],
    ]);
    const items = buildTree(
      [makeThread("server", api, 30), makeThread("laptop", api, 2, { environmentId: laptop })],
      { groups },
    );

    const header = items.find((item) => item.type === "v2-project");
    expect(header?.type === "v2-project" ? header.newThreadProjectKey : undefined).toBe(
      `${laptop}:${api}`,
    );
  });

  it("shows the compact time on rows that also show a status", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(BASE_MS);
    const items = buildTree([makeThread("working", api, 5, { hasPendingUserInput: true })]);
    const row = items.find((item) => item.type === "v2-thread");

    expect(row?.type === "v2-thread" ? row.timeLabel : undefined).toBe("5m");
  });
});

describe("project order", () => {
  it("adds projects it has not seen in front, without duplicates", () => {
    expect(mergeProjectOrder(["b", "c"], ["a", "c", "a", "d"])).toEqual(["a", "d", "b", "c"]);
  });

  it("moves a project past its neighbour and leaves hidden projects in place", () => {
    const order = ["a", "hidden", "b", "c"];

    expect(applyProjectMove(order, "b", { targetKey: "a", placement: "before" })).toEqual([
      "b",
      "a",
      "hidden",
      "c",
    ]);
    expect(applyProjectMove(order, "a", { targetKey: "c", placement: "after" })).toEqual([
      "hidden",
      "b",
      "c",
      "a",
    ]);
  });

  it("records an unlisted project when it moves", () => {
    expect(applyProjectMove(["a", "b"], "new", { targetKey: "b", placement: "after" })).toEqual([
      "a",
      "b",
      "new",
    ]);
  });
});

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, WORKER_THREAD_TAG } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildProjectThreadTreeListItems } from "./projectThreadTree";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
} from "./threadListV2";
import {
  buildWorkerShelfListItems,
  partitionWorkerThreads,
  withWorkerShelf,
} from "./workerThreadGroup";
import {
  isShelvedWorkerThread,
  workerTagMenuAction,
  workerThreadNeedsUser,
  type ThreadListV2WorkersShelfListItem,
} from "./workerThreads";

const environmentId = EnvironmentId.make("environment-1");
const api = ProjectId.make("api");
const web = ProjectId.make("web");
const NOW = "2026-06-02T12:00:00.000Z";
const BASE_MS = Date.parse(NOW);

function makeThread(
  id: string,
  options: {
    readonly minutesAgo?: number;
    readonly projectId?: ProjectId;
    readonly worker?: boolean;
    readonly overrides?: Partial<EnvironmentThreadShell>;
  } = {},
): EnvironmentThreadShell {
  const at = new Date(BASE_MS - (options.minutesAgo ?? 0) * 60_000).toISOString();
  const thread = makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId: options.projectId ?? api,
    title: id,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    ...options.overrides,
  });
  return options.worker
    ? { ...thread, source: { ...thread.source, tags: [WORKER_THREAD_TAG] } }
    : thread;
}

function failedRuntime(): EnvironmentThreadShell["runtime"] {
  return {
    status: "failed",
    activeRunId: null,
    providerInstanceId: makeThread("x").providerInstanceId,
    providerName: null,
    lastError: "boom",
    updatedAt: NOW,
  };
}

function threadIds(items: ReadonlyArray<ThreadListV2ListItem>): string[] {
  return items.flatMap((item) => (item.type === "v2-thread" ? [item.item.thread.id] : []));
}

describe("worker threads", () => {
  it("shelves a worker unless it is waiting on the user or its run failed", () => {
    expect(isShelvedWorkerThread(makeThread("plain"))).toBe(false);
    expect(isShelvedWorkerThread(makeThread("worker", { worker: true }))).toBe(true);
    for (const overrides of [
      { hasPendingApprovals: true },
      { hasPendingUserInput: true },
      { pendingSubagentRequest: "approval" as const },
      { runtime: failedRuntime() },
    ] satisfies ReadonlyArray<Partial<EnvironmentThreadShell>>) {
      const thread = makeThread("needs-you", { worker: true, overrides });
      expect(workerThreadNeedsUser(thread)).toBe(true);
      expect(isShelvedWorkerThread(thread)).toBe(false);
    }
  });

  it("offers Move to Workers or Move to Projects by the thread's tag", () => {
    expect(workerTagMenuAction(makeThread("plain")).title).toBe("Move to Workers");
    expect(workerTagMenuAction(makeThread("worker", { worker: true })).title).toBe(
      "Move to Projects",
    );
  });

  it("takes shelved workers out of the list, except while searching", () => {
    const plain = makeThread("plain");
    const quiet = makeThread("quiet", { worker: true });
    const asking = makeThread("asking", {
      worker: true,
      overrides: { hasPendingUserInput: true },
    });
    const threads = [plain, quiet, asking];

    const partition = partitionWorkerThreads(threads, "");
    expect(partition.listed).toEqual([plain, asking]);
    expect(partition.workers).toEqual([quiet]);

    const searching = partitionWorkerThreads(threads, "qui");
    expect(searching.listed).toBe(threads);
    expect(searching.workers).toEqual([]);

    expect(partitionWorkerThreads([plain], "").listed).toEqual([plain]);
  });

  it("leaves shelved workers out of the arranged sections", () => {
    const threads = [makeThread("plain"), makeThread("quiet", { worker: true })];
    const ordered = getThreadListV2OrderedSection({ threads, section: "active", now: NOW });
    expect(ordered.map((thread) => thread.id)).toEqual(["plain"]);
  });
});

describe("Workers shelf", () => {
  const workers = [
    makeThread("older", { worker: true, minutesAgo: 30 }),
    makeThread("newer", { worker: true, minutesAgo: 5 }),
    makeThread("other-project", { worker: true, projectId: web }),
    makeThread("archived", { worker: true, overrides: { archivedAt: NOW } }),
  ];

  it("is collapsed to a counted header, keeping only the selected worker", () => {
    expect(
      buildWorkerShelfListItems({
        workers,
        environmentId: null,
        now: NOW,
        expanded: false,
        layout: "flat",
      }),
    ).toEqual([{ type: "v2-workers-shelf", key: "v2-workers-shelf", count: 3, expanded: false }]);

    const selected = buildWorkerShelfListItems({
      workers,
      environmentId: null,
      now: NOW,
      expanded: false,
      selectedThreadKey: `${environmentId}:older`,
      layout: "flat",
    });
    expect(threadIds(selected)).toEqual(["older"]);
  });

  it("lists workers newest first when expanded, within the list's project filter", () => {
    const items = buildWorkerShelfListItems({
      workers,
      environmentId: null,
      projectRefs: [{ environmentId, projectId: api }],
      now: NOW,
      expanded: true,
      layout: "flat",
    });
    expect(items[0]).toMatchObject({ type: "v2-workers-shelf", count: 2, expanded: true });
    expect(threadIds(items)).toEqual(["newer", "older"]);
    const rows = items.filter((item) => item.type === "v2-thread");
    expect(rows.map((row) => row.showTrailingDivider)).toEqual([true, false]);
  });

  it("keeps a snoozed or settled worker's slim look", () => {
    const items = buildWorkerShelfListItems({
      workers: [
        makeThread("snoozed", {
          worker: true,
          overrides: { snoozedUntil: "2026-06-03T12:00:00.000Z", snoozedAt: NOW },
        }),
        makeThread("settled", { worker: true, overrides: { settledOverride: "settled" } }),
      ],
      environmentId: null,
      now: NOW,
      expanded: true,
      layout: "flat",
    });
    const rows = items.flatMap((item) => (item.type === "v2-thread" ? [item.item] : []));
    expect(rows.map((row) => [row.thread.id, row.variant, row.snoozed])).toEqual(
      expect.arrayContaining([
        ["snoozed", "slim", true],
        ["settled", "slim", false],
      ]),
    );
  });

  it("is empty when no worker is in scope", () => {
    expect(
      buildWorkerShelfListItems({
        workers,
        environmentId: EnvironmentId.make("elsewhere"),
        now: NOW,
        expanded: true,
        layout: "tree",
      }),
    ).toEqual([]);
  });

  it("goes at the end of the project tree, and before the flat list's Settled shelf", () => {
    const plain = makeThread("plain");
    const settled = makeThread("settled", { overrides: { settledOverride: "settled" } });
    const quiet = makeThread("quiet", { worker: true });
    const { listed, workers: shelved } = partitionWorkerThreads([plain, settled, quiet], "");
    const layout = buildThreadListV2Items({
      threads: listed,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: true,
    });
    const flat = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfExpanded: true,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });
    const shelf = buildWorkerShelfListItems({
      workers: shelved,
      environmentId: null,
      now: NOW,
      expanded: true,
      layout: "flat",
    });
    expect(withWorkerShelf(flat, shelf).map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:plain`,
      "v2-workers-shelf",
      `v2-thread:${environmentId}:quiet`,
      "v2-settled-shelf",
      `v2-thread:${environmentId}:settled`,
    ]);

    const tree = buildProjectThreadTreeListItems({
      listItems: flat,
      projectGroups: new Map(),
      collapsedProjectKeys: new Set(),
      expandedProjectKeys: new Set(),
    });
    const treeShelf = buildWorkerShelfListItems({
      workers: shelved,
      environmentId: null,
      now: NOW,
      expanded: true,
      layout: "tree",
    });
    expect(withWorkerShelf(tree, treeShelf).map((item) => item.type)).toEqual([
      "v2-project",
      "v2-thread",
      "v2-thread",
      "v2-workers-shelf",
      "v2-thread",
    ]);
    expect(withWorkerShelf(tree, [])).toBe(tree);
  });

  it("compares shelf headers by count and expansion", () => {
    const header: ThreadListV2WorkersShelfListItem = {
      type: "v2-workers-shelf",
      key: "v2-workers-shelf",
      count: 2,
      expanded: false,
    };
    expect(threadListV2ListItemsAreEqual(header, { ...header })).toBe(true);
    expect(threadListV2ListItemsAreEqual(header, { ...header, count: 3 })).toBe(false);
    expect(threadListV2ListItemsAreEqual(header, { ...header, expanded: true })).toBe(false);
  });
});

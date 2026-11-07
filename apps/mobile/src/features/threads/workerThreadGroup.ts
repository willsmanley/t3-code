import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  isListedThreadLineage,
  isWorkerThread,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

import { toTreeRow } from "./projectThreadTree";
import {
  buildThreadListV2ListItems,
  resolveThreadListV2WokeAt,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
} from "./threadListV2";
import {
  isShelvedWorkerThread,
  type ThreadListV2WorkerJobsListItem,
  type ThreadListV2WorkersShelfListItem,
} from "./workerThreads";

const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * Splits shelved workers from the threads the list lays out as usual. A search lists every
 * match in rank order, workers included, so nothing is shelved while searching.
 */
export function partitionWorkerThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  searchQuery: string,
): {
  readonly listed: ReadonlyArray<EnvironmentThreadShell>;
  readonly workers: ReadonlyArray<EnvironmentThreadShell>;
} {
  if (searchQuery.trim().length > 0) return { listed: threads, workers: NO_THREADS };
  const workers = threads.filter(isShelvedWorkerThread);
  if (workers.length === 0) return { listed: threads, workers: NO_THREADS };
  return { listed: threads.filter((thread) => !isShelvedWorkerThread(thread)), workers };
}

/**
 * Android's bottom tabs split the list (F18): Projects leaves shelved workers out (one that needs
 * the user stays, as on desktop), and Workers lists every worker thread.
 */
export function threadsForWorkerTab(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  tab: "projects" | "workers",
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter((thread) =>
    tab === "workers" ? isWorkerThread(thread.source) : !isShelvedWorkerThread(thread),
  );
}

/**
 * The Workers tab's closing item: how to make a worker when there is none in scope, then the jobs
 * that run in project threads. Left out while searching, so an empty search says so.
 */
export function buildWorkerJobsListItems(input: {
  readonly workers: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchQuery: string;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
}): ThreadListV2ListItem[] {
  if (input.searchQuery.trim().length > 0) return [];
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;
  const workerCount = input.workers.filter(
    (thread) =>
      thread.archivedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  ).length;
  const item: ThreadListV2WorkerJobsListItem = {
    type: "v2-worker-jobs",
    key: "v2-worker-jobs",
    workerCount,
  };
  return [item];
}

/**
 * The Workers shelf header and its rows, newest activity first. Collapsed, it shows only the
 * selected thread, like the other shelves. Tree rows get the project tree's time label.
 */
export function buildWorkerShelfListItems(input: {
  readonly workers: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  /** Decides snooze and wake state, like the list's layout time. */
  readonly now: string;
  /** The minute snooze labels read. */
  readonly snoozeLabelNow?: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly expanded: boolean;
  readonly selectedThreadKey?: string | null;
  readonly layout: "flat" | "tree";
}): ThreadListV2ListItem[] {
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;
  const workers = input.workers
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        (input.environmentId === null || thread.environmentId === input.environmentId) &&
        (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
    )
    .map((thread) => ({ thread, activity: getThreadSortTimestamp(thread, "updated_at") }))
    .sort(
      (left, right) =>
        right.activity - left.activity || left.thread.id.localeCompare(right.thread.id),
    )
    .map(({ thread }) => thread);
  if (workers.length === 0) return [];

  const visible = input.expanded
    ? workers
    : workers.filter(
        (thread) => `${thread.environmentId}:${thread.id}` === input.selectedThreadKey,
      );
  const items = visible.map((thread, index): ThreadListV2Item => {
    const snoozed =
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now });
    const settled =
      !snoozed &&
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      input.queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true;
    const slim = snoozed || settled;
    return {
      thread,
      variant: slim ? "slim" : "card",
      snoozed,
      pinned: !slim && thread.pinnedAt != null,
      wokeAt: slim ? null : resolveThreadListV2WokeAt(thread, { now: input.now }),
      isLast: index === visible.length - 1,
    };
  });
  const rows = buildThreadListV2ListItems({
    items,
    pendingTasks: [],
    ...(input.snoozeLabelNow === undefined ? {} : { snoozeLabelNow: input.snoozeLabelNow }),
    ...(input.snoozeEnvironmentIds === undefined
      ? {}
      : { snoozeEnvironmentIds: input.snoozeEnvironmentIds }),
    ...(input.queuedThreadKeys === undefined ? {} : { queuedThreadKeys: input.queuedThreadKeys }),
  });
  const header: ThreadListV2WorkersShelfListItem = {
    type: "v2-workers-shelf",
    key: "v2-workers-shelf",
    count: workers.length,
    expanded: input.expanded,
  };
  return [
    header,
    ...(input.layout === "tree"
      ? rows.map((row) => (row.type === "v2-thread" ? toTreeRow(row) : row))
      : rows),
  ];
}

/**
 * Adds the Workers shelf at the end of the list. The flat list puts it before the Settled shelf
 * instead, so the settled "Show more" footer stays under the settled rows.
 */
export function withWorkerShelf(
  items: ThreadListV2ListItem[],
  shelf: ReadonlyArray<ThreadListV2ListItem>,
): ThreadListV2ListItem[] {
  if (shelf.length === 0) return items;
  const settledIndex = items.findIndex((item) => item.type === "v2-settled-shelf");
  if (settledIndex === -1) return [...items, ...shelf];
  return [...items.slice(0, settledIndex), ...shelf, ...items.slice(settledIndex)];
}

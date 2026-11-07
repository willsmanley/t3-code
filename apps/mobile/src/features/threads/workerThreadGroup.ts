import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage, type EnvironmentId, type ProjectId } from "@t3tools/contracts";

import { groupWorkerRowsByFolder, toTreeRow } from "./projectThreadTree";
import {
  buildThreadListV2ListItems,
  resolveThreadListV2WokeAt,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { isShelvedWorkerThread, type ThreadListV2WorkersShelfListItem } from "./workerThreads";

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
 * The Workers shelf header and its rows, newest activity first. Collapsed, it shows only the
 * selected thread, like the other shelves. Tree rows get the tree's time label and, with
 * `folders`, sit under folder headers (F20).
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
  readonly folders?: {
    readonly order: ReadonlyArray<string>;
    readonly collapsedGroupKeys: ReadonlySet<string>;
  };
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
  if (input.layout === "flat") return [header, ...rows];
  const treeRows = rows.map((row) => (row.type === "v2-thread" ? toTreeRow(row) : row));
  if (!input.expanded || input.folders === undefined) return [header, ...treeRows];
  return [
    header,
    ...groupWorkerRowsByFolder({
      rows: treeRows,
      folderOrder: input.folders.order,
      collapsedGroupKeys: input.folders.collapsedGroupKeys,
      selectedThreadKey: input.selectedThreadKey ?? null,
    }),
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

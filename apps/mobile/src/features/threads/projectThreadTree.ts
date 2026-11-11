import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  chooseFolderThreadProject,
  folderOfTags,
  groupByFolder,
} from "@t3tools/client-runtime/thread-folders";

import { relativeTime } from "../../lib/time";
import { scopedProjectKey } from "../../lib/scopedEntities";
import {
  folderGroupKey,
  type ThreadListV2FolderHeaderListItem,
  type ThreadListV2FolderMoreListItem,
} from "./threadFolderListItems";
import {
  resolveThreadListV2Status,
  threadHasUnseenCompletion,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "./threadListV2";

/** Matches the desktop project tree's default thread preview count. */
export const PROJECT_THREAD_TREE_PREVIEW_COUNT = 6;

export type ThreadStatusDotKind =
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "limited"
  | "working"
  | "waiting"
  | "woke"
  | "done";

const DOT_PRIORITY: Record<ThreadStatusDotKind, number> = {
  approval: 0,
  input: 1,
  request: 2,
  failed: 3,
  limited: 4,
  woke: 5,
  working: 6,
  waiting: 7,
  done: 8,
};

export function resolveThreadStatusDot(
  item: Pick<ThreadListV2Item, "thread" | "wokeAt">,
): ThreadStatusDotKind | null {
  const status = resolveThreadListV2Status(item.thread);
  if (status !== "ready") return status;
  if (item.wokeAt !== null) return "woke";
  return threadHasUnseenCompletion(item.thread) ? "done" : null;
}

function mostUrgentDot(
  current: ThreadStatusDotKind | null,
  candidate: ThreadStatusDotKind | null,
): ThreadStatusDotKind | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return DOT_PRIORITY[candidate] < DOT_PRIORITY[current] ? candidate : current;
}

/** Places a folder just before or after another one. */
export interface FolderMove {
  readonly target: string;
  readonly placement: "before" | "after";
}

/** Moves a folder next to another; folders not in `order` leave it unchanged. */
export function moveFolderNextTo(
  order: ReadonlyArray<string>,
  folder: string,
  move: FolderMove,
): string[] {
  if (folder === move.target || !order.includes(folder)) return [...order];
  const next = order.filter((name) => name !== folder);
  const targetIndex = next.indexOf(move.target);
  if (targetIndex < 0) return [...order];
  next.splice(move.placement === "before" ? targetIndex : targetIndex + 1, 0, folder);
  return next;
}

function sortTreeRows(
  rows: ReadonlyArray<ThreadListV2ThreadListItem>,
): ThreadListV2ThreadListItem[] {
  // Pinned threads keep their arranged order at the top; the rest follow the
  // desktop tree's most-recent-first order.
  const pinned = rows.filter((row) => row.item.pinned);
  const rest = rows
    .filter((row) => !row.item.pinned)
    .map((row) => ({ row, activity: getThreadSortTimestamp(row.item.thread, "updated_at") }))
    .sort((left, right) => right.activity - left.activity)
    .map(({ row }) => row);
  return [...pinned, ...rest];
}

function rowThreadKey(row: ThreadListV2ThreadListItem): string {
  return `${row.item.thread.environmentId}:${row.item.thread.id}`;
}

function newThreadProjectKey(rows: ReadonlyArray<ThreadListV2ThreadListItem>): string | null {
  return chooseFolderThreadProject({
    folderThreads: rows.map(({ item: { thread } }) => ({
      project: scopedProjectKey(thread.environmentId, thread.projectId),
      activeAt: thread.latestUserMessageAt ?? thread.updatedAt,
    })),
    current: null,
    first: null,
  });
}

/**
 * Regroups the flat list under folder headers, in `folderOrder`, then Unfiled. Pass items built
 * with the settled shelf open and no settled limit; snoozed threads go to the Snoozed shelf after
 * the folders. Empty folders, Unfiled included, show only with `showEmptyFolders`.
 */
export function buildFolderThreadTreeListItems(input: {
  readonly listItems: ReadonlyArray<ThreadListV2ListItem>;
  readonly folderOrder: ReadonlyArray<string>;
  /** Folder group keys (see `folderGroupKey`) that are collapsed. */
  readonly collapsedGroupKeys: ReadonlySet<string>;
  /** Folder group keys whose "Show more" is open. */
  readonly expandedGroupKeys: ReadonlySet<string>;
  readonly showEmptyFolders: boolean;
  /** Show Unfiled even when empty, for its New folder button; defaults to `showEmptyFolders`. */
  readonly showUnfiled?: boolean;
  /** Unfiled may offer a folder per project while no folder exists. */
  readonly offerFolderPerProject?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly preferencesLoading?: boolean;
}): ThreadListV2ListItem[] {
  const pending: ThreadListV2ListItem[] = [];
  const snoozedShelf: ThreadListV2ListItem[] = [];
  const threadRows: ThreadListV2ThreadListItem[] = [];
  for (const entry of input.listItems) {
    if (entry.type === "v2-pending") {
      pending.push(entry);
      continue;
    }
    if (entry.type === "v2-snoozed-shelf") {
      snoozedShelf.push(entry);
      continue;
    }
    if (entry.type !== "v2-thread") continue;
    // Search lists snoozed matches without the shelf; those keep their folder.
    if (entry.item.snoozed && snoozedShelf.length > 0) {
      snoozedShelf.push(toTreeRow(entry));
      continue;
    }
    threadRows.push(entry);
  }

  const result: ThreadListV2ListItem[] = pending.map((entry) =>
    entry.type === "v2-pending" && entry.showTrailingDivider
      ? { ...entry, showTrailingDivider: false }
      : entry,
  );
  const grouped = groupByFolder(
    threadRows,
    (row) => folderOfTags(row.item.thread.source.tags),
    input.folderOrder,
  );
  const folders = grouped.folders.filter(
    (group) => input.showEmptyFolders || group.threads.length > 0,
  );
  const groups = [
    ...folders.map((group) => ({ folder: group.folder as string | null, rows: group.threads })),
    ...((input.showUnfiled ?? input.showEmptyFolders) || grouped.unfiled.length > 0
      ? [{ folder: null, rows: grouped.unfiled }]
      : []),
  ];
  for (const [groupIndex, group] of groups.entries()) {
    const groupKey = folderGroupKey(group.folder);
    const rows = sortTreeRows(group.rows);
    const collapsed = input.collapsedGroupKeys.has(groupKey);
    const expanded = input.expandedGroupKeys.has(groupKey);
    let status: ThreadStatusDotKind | null = null;
    for (const row of rows) status = mostUrgentDot(status, resolveThreadStatusDot(row.item));
    const header: ThreadListV2FolderHeaderListItem = {
      type: "v2-folder",
      key: `v2-folder:${groupKey}`,
      folder: group.folder,
      threadCount: rows.length,
      collapsed,
      status: collapsed ? status : null,
      newThreadProjectKey: newThreadProjectKey(rows),
      previousFolder: group.folder === null ? null : (folders[groupIndex - 1]?.folder ?? null),
      nextFolder: group.folder === null ? null : (folders[groupIndex + 1]?.folder ?? null),
      canArrange: input.folderOrder.length > 1,
      offerFolderPerProject:
        input.offerFolderPerProject !== false &&
        group.folder === null &&
        input.folderOrder.length === 0 &&
        input.preferencesLoading !== true,
      disabled: input.preferencesLoading === true,
    };
    result.push(header);

    const selected =
      input.selectedThreadKey == null
        ? undefined
        : rows.find((row) => rowThreadKey(row) === input.selectedThreadKey);
    if (collapsed) {
      // A collapsed folder keeps the open thread in view, like the desktop sidebar.
      if (selected !== undefined) result.push(toTreeRow(selected));
      continue;
    }
    const preview = expanded ? rows : rows.slice(0, PROJECT_THREAD_TREE_PREVIEW_COUNT);
    const visible =
      selected === undefined || preview.includes(selected) ? preview : [...preview, selected];
    for (const row of visible) result.push(toTreeRow(row));
    if (rows.length > PROJECT_THREAD_TREE_PREVIEW_COUNT) {
      const more: ThreadListV2FolderMoreListItem = {
        type: "v2-folder-more",
        key: `v2-folder-more:${groupKey}`,
        folder: group.folder,
        hiddenCount: rows.length - visible.length,
        expanded,
      };
      result.push(more);
    }
  }
  result.push(...snoozedShelf);
  return result;
}

export function toTreeRow(row: ThreadListV2ThreadListItem): ThreadListV2ThreadListItem {
  const thread = row.item.thread;
  // Tree rows always show the compact time beside the status dot; the flat
  // list hides it whenever a status label takes its place.
  const timeLabel = relativeTime(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  return row.timeLabel === timeLabel && !row.showTrailingDivider
    ? row
    : { ...row, timeLabel, showTrailingDivider: false };
}

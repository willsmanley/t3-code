import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";

import { relativeTime } from "../../lib/time";
import { scopedProjectKey } from "../../lib/scopedEntities";
import {
  resolveThreadListV2Status,
  threadHasUnseenCompletion,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ProjectHeaderListItem,
  type ThreadListV2ProjectMoreListItem,
  type ThreadListV2ThreadListItem,
} from "./threadListV2";

/** Matches the desktop project tree's default thread preview count. */
export const PROJECT_THREAD_TREE_PREVIEW_COUNT = 6;

export type ThreadStatusDotKind =
  | "approval"
  | "input"
  | "failed"
  | "limited"
  | "working"
  | "waiting"
  | "woke"
  | "done";

const DOT_PRIORITY: Record<ThreadStatusDotKind, number> = {
  approval: 0,
  input: 1,
  failed: 2,
  limited: 3,
  woke: 4,
  working: 5,
  waiting: 6,
  done: 7,
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

interface ProjectGroup {
  readonly projectKey: string;
  readonly title: string;
  readonly rows: ThreadListV2ThreadListItem[];
  latestActivity: number;
  newThreadProjectKey: string;
}

/**
 * Regroups the flat thread list under project headers, like the desktop
 * project tree. Pass list items built with every shelf expanded and no settled
 * limit: settled and snoozed threads stay in their project instead of a shelf.
 * `projectGroups` maps each environment project to its logical project, so one
 * repository open in several environments shares a header.
 */
export function buildProjectThreadTreeListItems(input: {
  readonly listItems: ReadonlyArray<ThreadListV2ListItem>;
  readonly projectGroups: ReadonlyMap<string, { readonly key: string; readonly title: string }>;
  readonly collapsedProjectKeys: ReadonlySet<string>;
  readonly expandedProjectKeys: ReadonlySet<string>;
  readonly selectedThreadKey?: string | null;
  readonly preferencesLoading?: boolean;
}): ThreadListV2ListItem[] {
  const pending: ThreadListV2ListItem[] = [];
  const groups = new Map<string, ProjectGroup>();
  for (const entry of input.listItems) {
    if (entry.type === "v2-pending") {
      pending.push(entry);
      continue;
    }
    if (entry.type !== "v2-thread") continue;
    const thread = entry.item.thread;
    const scopedKey = scopedProjectKey(thread.environmentId, thread.projectId);
    const projectGroup = input.projectGroups.get(scopedKey);
    const projectKey = projectGroup?.key ?? scopedKey;
    const activity = getThreadSortTimestamp(thread, "updated_at");
    const group = groups.get(projectKey);
    if (group === undefined) {
      groups.set(projectKey, {
        projectKey,
        title: projectGroup?.title ?? "Project",
        rows: [entry],
        latestActivity: activity,
        newThreadProjectKey: scopedKey,
      });
    } else {
      group.rows.push(entry);
      if (activity > group.latestActivity) {
        group.latestActivity = activity;
        group.newThreadProjectKey = scopedKey;
      }
    }
  }

  const result: ThreadListV2ListItem[] = pending.map((entry) =>
    entry.type === "v2-pending" && entry.showTrailingDivider
      ? { ...entry, showTrailingDivider: false }
      : entry,
  );
  const orderedGroups = [...groups.values()].sort(
    (left, right) =>
      right.latestActivity - left.latestActivity ||
      (left.projectKey < right.projectKey ? -1 : left.projectKey > right.projectKey ? 1 : 0),
  );
  for (const group of orderedGroups) {
    // Pinned threads keep their arranged order at the top; the rest follow the
    // desktop tree's most-recent-first order.
    const pinned = group.rows.filter((row) => row.item.pinned);
    const rest = group.rows
      .filter((row) => !row.item.pinned)
      .map((row) => ({ row, activity: getThreadSortTimestamp(row.item.thread, "updated_at") }))
      .sort((left, right) => right.activity - left.activity)
      .map(({ row }) => row);
    const rows = [...pinned, ...rest];
    const collapsed = input.collapsedProjectKeys.has(group.projectKey);
    const expanded = input.expandedProjectKeys.has(group.projectKey);
    let status: ThreadStatusDotKind | null = null;
    for (const row of rows) status = mostUrgentDot(status, resolveThreadStatusDot(row.item));
    const header: ThreadListV2ProjectHeaderListItem = {
      type: "v2-project",
      key: `v2-project:${group.projectKey}`,
      projectKey: group.projectKey,
      title: group.title,
      threadCount: rows.length,
      collapsed,
      status: collapsed ? status : null,
      newThreadProjectKey: group.newThreadProjectKey,
      disabled: input.preferencesLoading === true,
    };
    result.push(header);
    if (collapsed) continue;

    const preview = expanded ? rows : rows.slice(0, PROJECT_THREAD_TREE_PREVIEW_COUNT);
    const selected =
      input.selectedThreadKey == null
        ? undefined
        : rows
            .slice(preview.length)
            .find(
              (row) =>
                `${row.item.thread.environmentId}:${row.item.thread.id}` ===
                input.selectedThreadKey,
            );
    const visible = selected === undefined ? preview : [...preview, selected];
    for (const row of visible) result.push(toTreeRow(row));
    if (rows.length > PROJECT_THREAD_TREE_PREVIEW_COUNT) {
      const more: ThreadListV2ProjectMoreListItem = {
        type: "v2-project-more",
        key: `v2-project-more:${group.projectKey}`,
        projectKey: group.projectKey,
        hiddenCount: rows.length - visible.length,
        expanded,
      };
      result.push(more);
    }
  }
  return result;
}

function toTreeRow(row: ThreadListV2ThreadListItem): ThreadListV2ThreadListItem {
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

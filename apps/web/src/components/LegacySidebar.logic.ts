import type { ThreadSortInput } from "@t3tools/client-runtime/state/thread-sort";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";

import { sortScopedProjectsForSidebar, type ThreadStatusPill } from "./Sidebar.logic";

// Fork (F1): helpers only the project-tree sidebar uses, kept here after
// upstream removed them from `Sidebar.logic.ts` with that sidebar.
const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  "Guest Request": 3.75,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

/** Upstream's scoped project sort, with every project and thread in one scope. */
export function sortProjectsForSidebar<
  TProject extends {
    id: string;
    title: string;
    createdAt?: string | undefined;
    updatedAt?: string | undefined;
  },
  TThread extends ThreadSortInput & { projectId: string },
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return sortScopedProjectsForSidebar(
    projects.map((project) => ({ ...project, environmentId: "" })),
    threads.map((thread) => ({ ...thread, environmentId: "", archivedAt: null })),
    sortOrder,
  ).flatMap((project) => {
    const original = projectById.get(project.id);
    return original === undefined ? [] : [original];
  });
}

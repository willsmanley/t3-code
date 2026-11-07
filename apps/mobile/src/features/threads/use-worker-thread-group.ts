import { useAtom } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { folderGroupKey } from "./threadFolderListItems";
import { threadListV2LayoutTime } from "./threadListV2";
import { buildWorkerShelfListItems, partitionWorkerThreads } from "./workerThreadGroup";

/** Collapsed at launch; the home list and the sidebar share it for the session. */
const workersShelfExpandedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-list:workers-shelf-expanded"),
);

/** Folders closed inside the Workers shelf, for the session, like the desktop Workers tab (F20). */
const collapsedWorkerFoldersAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-list:workers-shelf-collapsed-folders"),
);

/**
 * Fork: takes shelved workers out of the threads a list lays out and builds the Workers shelf
 * that the list appends with `withWorkerShelf`.
 */
export function useWorkerThreadGroup(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchQuery: string;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly now: string;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
  readonly layout: "flat" | "tree";
  /** Groups the shelf's rows by folder in this order (tree layout only). */
  readonly folderOrder: ReadonlyArray<string> | null;
}) {
  const [expanded, setExpanded] = useAtom(workersShelfExpandedAtom);
  const [collapsedFolders, setCollapsedFolders] = useAtom(collapsedWorkerFoldersAtom);
  const { threads, searchQuery } = input;
  const { listed, workers } = useMemo(
    () => partitionWorkerThreads(threads, searchQuery),
    [threads, searchQuery],
  );
  const layoutTime = useMemo(
    () => threadListV2LayoutTime({ threads: workers, now: input.now, searchQuery: "" }),
    [workers, input.now],
  );
  const snoozeLabelNow = `${input.now.slice(0, 16)}:00.000Z`;
  const shelfItems = useMemo(
    () =>
      buildWorkerShelfListItems({
        workers,
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        now: layoutTime,
        snoozeLabelNow,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        expanded,
        selectedThreadKey: input.selectedThreadKey,
        layout: input.layout,
        ...(input.folderOrder === null
          ? {}
          : { folders: { order: input.folderOrder, collapsedGroupKeys: collapsedFolders } }),
      }),
    [
      workers,
      input.environmentId,
      input.projectRefs,
      layoutTime,
      snoozeLabelNow,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      expanded,
      input.selectedThreadKey,
      input.layout,
      input.folderOrder,
      collapsedFolders,
    ],
  );
  return {
    listedThreads: listed,
    shelfItems,
    toggleWorkersShelf: () => setExpanded((current) => !current),
    toggleWorkerFolder: (folder: string | null) =>
      setCollapsedFolders((current) => {
        const key = folderGroupKey(folder);
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
  } as const;
}

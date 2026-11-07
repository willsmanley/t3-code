import { useAtom } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { threadListV2LayoutTime } from "./threadListV2";
import {
  buildWorkerJobsListItems,
  buildWorkerShelfListItems,
  partitionWorkerThreads,
  threadsForWorkerTab,
} from "./workerThreadGroup";

/** Collapsed at launch; the home list and the sidebar share it for the session. */
const workersShelfExpandedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-list:workers-shelf-expanded"),
);

/**
 * Fork: takes shelved workers out of the threads a list lays out and builds what the list appends
 * with `withWorkerShelf`. `tab` is Android's bottom tab (F18): Projects has no Workers shelf, and
 * Workers lists only workers, then the jobs in project threads. iOS has no such tabs (`null`): its
 * list keeps the collapsed Workers shelf.
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
  readonly tab: "projects" | "workers" | null;
}) {
  const [expanded, setExpanded] = useAtom(workersShelfExpandedAtom);
  const { threads, searchQuery, tab } = input;
  const { listed, workers } = useMemo(
    () =>
      tab === null
        ? partitionWorkerThreads(threads, searchQuery)
        : { listed: threadsForWorkerTab(threads, tab), workers: [] },
    [threads, searchQuery, tab],
  );
  const layoutTime = useMemo(
    () => threadListV2LayoutTime({ threads: workers, now: input.now, searchQuery: "" }),
    [workers, input.now],
  );
  const snoozeLabelNow = `${input.now.slice(0, 16)}:00.000Z`;
  const shelfItems = useMemo(
    () =>
      tab === "workers"
        ? buildWorkerJobsListItems({
            workers: listed,
            searchQuery,
            environmentId: input.environmentId,
            projectRefs: input.projectRefs,
          })
        : buildWorkerShelfListItems({
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
          }),
    [
      tab,
      listed,
      searchQuery,
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
    ],
  );
  return {
    listedThreads: listed,
    shelfItems,
    toggleWorkersShelf: () => setExpanded((current) => !current),
  } as const;
}

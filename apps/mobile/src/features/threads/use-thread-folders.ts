// Fork (F20): folder state for the Android thread tree and the thread row menu.
import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { moveFolderNextTo, type FolderMove } from "./projectThreadTree";
import {
  setFolderOrder,
  threadFolderMenu,
  threadFolderOrderAtom,
  toggleFolderCollapsed,
  watchSentDraftFolder,
} from "./threadFolderActions";
import { folderGroupKey } from "./threadFolderListItems";

const NO_KEYS: ReadonlySet<string> = new Set();

/** Folders closed in the Workers tab, for the session, like the desktop Workers tab. */
const collapsedWorkerFoldersAtom = Atom.make(NO_KEYS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-list:workers-collapsed-folders"),
);

/**
 * Folder order and the Projects tab's collapse state persist on this device, like the desktop
 * sidebar's. "Show more" is per visit, so a long folder returns to its preview the next time the
 * list mounts.
 */
export function useThreadFolderTreeState(tab: "projects" | "workers") {
  // Imperative folder actions write preferences through the registry.
  useAtomMount(updateMobilePreferencesAtom);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const preferences = loaded ? preferencesResult.value : null;
  const collapsedFolders = preferences?.collapsedThreadFolders;
  const unfiledCollapsed = preferences?.unfiledThreadsCollapsed;
  const savedCollapsedGroupKeys = useMemo(
    () =>
      new Set([
        ...(collapsedFolders ?? []).map(folderGroupKey),
        ...(unfiledCollapsed === true ? [folderGroupKey(null)] : []),
      ]),
    [collapsedFolders, unfiledCollapsed],
  );
  const [collapsedWorkerFolders, setCollapsedWorkerFolders] = useAtom(collapsedWorkerFoldersAtom);
  const collapsedGroupKeys = tab === "workers" ? collapsedWorkerFolders : savedCollapsedGroupKeys;
  const folderOrder = useAtomValue(threadFolderOrderAtom);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState(NO_KEYS);
  const [arrangingFolders, setArrangingFolders] = useState(false);

  // A string key, so a rebuilt preferences object with the same sent drafts does not resubscribe.
  const sentDrafts = Object.entries(preferences?.pendingThreadFolders ?? {}).filter(
    ([, pending]) => pending.thread !== undefined,
  );
  const sentDraftsJson = sentDrafts.length === 0 ? null : JSON.stringify(sentDrafts);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches the thread list for drafts sent from a folder before the app last closed
  useEffect(() => {
    if (sentDraftsJson === null) return;
    const entries: typeof sentDrafts = JSON.parse(sentDraftsJson);
    for (const [requestId, pending] of entries) watchSentDraftFolder(requestId, pending);
  }, [sentDraftsJson]);

  return {
    loaded,
    folderOrder,
    collapsedGroupKeys,
    expandedGroupKeys,
    arrangingFolders,
    toggleFolderCollapsed: (folder: string | null) => {
      if (tab === "workers") setCollapsedWorkerFolders((current) => toggleKey(current, folder));
      else if (loaded) toggleFolderCollapsed(folder);
    },
    toggleFolderExpanded: (folder: string | null) =>
      setExpandedGroupKeys((current) => toggleKey(current, folder)),
    moveFolder: (folder: string, move: FolderMove) => {
      if (loaded) setFolderOrder((order) => moveFolderNextTo(order, folder, move));
    },
    openFolderArrangement: () => setArrangingFolders(true),
    closeFolderArrangement: () => setArrangingFolders(false),
  } as const;
}

function toggleKey(keys: ReadonlySet<string>, folder: string | null): ReadonlySet<string> {
  const key = folderGroupKey(folder);
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The thread row's "Move to folder" items. */
export function useThreadFolderMenu(thread: EnvironmentThreadShell) {
  const folders = useAtomValue(threadFolderOrderAtom);
  return useMemo(() => threadFolderMenu(thread, folders), [thread, folders]);
}

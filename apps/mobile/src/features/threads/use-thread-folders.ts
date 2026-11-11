// Fork (F20): folder state for the Android thread tree and the thread row menu.
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { deviceFolderMigrationStep } from "@t3tools/client-runtime/thread-folders";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { moveFolderNextTo, type FolderMove } from "./projectThreadTree";
import {
  forgetLegacyDeviceFolders,
  legacyDeviceFolders,
  setFolderOrder,
  threadFolderMenu,
  threadFolderOrderAtom,
  threadFolderSettings,
  toggleFolderCollapsed,
  watchSentDraftFolder,
} from "./threadFolderActions";
import { folderGroupKey } from "./threadFolderListItems";

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Folder order, collapse state and the default folder come from the servers, so every device
 * shows the same folders, in the Projects and Workers tabs alike. "Show more" is per visit, so a
 * long folder returns to its preview the next time the list mounts.
 */
export function useThreadFolderTreeState() {
  // Imperative folder actions write preferences through the registry.
  useAtomMount(updateMobilePreferencesAtom);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const view = useAtomValue(threadFolderSettings.viewAtom);
  const settingsLoaded = useAtomValue(threadFolderSettings.loadedAtom);
  const loaded = preferences !== null && settingsLoaded;
  const collapsedGroupKeys = useMemo(
    () =>
      new Set([
        ...[...view.collapsed].map(folderGroupKey),
        ...(view.unfiledCollapsed ? [folderGroupKey(null)] : []),
      ]),
    [view],
  );
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

  useDeviceFolderMigration(preferences === null ? null : legacyDeviceFolders(preferences));

  return {
    loaded,
    folderOrder,
    collapsedGroupKeys,
    expandedGroupKeys,
    arrangingFolders,
    defaultFolder: view.defaultFolder,
    serverBacked: view.serverBacked,
    toggleFolderCollapsed: (folder: string | null) => {
      if (loaded) toggleFolderCollapsed(folder);
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

/** Hands the phone's saved folder list to the servers once, then forgets it. */
function useDeviceFolderMigration(device: ReturnType<typeof legacyDeviceFolders>) {
  const environmentIds = useAtomValue(threadFolderSettings.supportedEnvironmentIdsAtom);
  const settings = useAtomValue(threadFolderSettings.settingsByEnvironmentAtom);
  const running = useRef(false);
  const deviceJson = device === null ? null : JSON.stringify(device);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the folder list saved in this phone's preferences to the servers once they report their folder settings
  useEffect(() => {
    if (deviceJson === null || running.current) return;
    const step = deviceFolderMigrationStep({
      device: JSON.parse(deviceJson),
      environmentIds,
      settings,
    });
    if (step.type === "wait") return;
    if (step.type === "forget") {
      forgetLegacyDeviceFolders();
      return;
    }
    running.current = true;
    void threadFolderSettings.apply(appAtomRegistry, step.update).then((outcome) => {
      running.current = false;
      if (outcome.failure === null) forgetLegacyDeviceFolders();
    });
  }, [deviceJson, environmentIds, settings]);
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

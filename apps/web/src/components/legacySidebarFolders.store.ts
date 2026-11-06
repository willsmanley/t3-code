// Fork (F20): folder state and actions for the legacy sidebar. Membership is the thread tag
// `folder:<name>`, set through the existing `thread.tag.set` command; the order, empty folders,
// collapse state and folders wanted for unsent drafts stay on this device.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, readThreadShells } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { ORCHESTRATION_OPERATE_DENIED_MESSAGE } from "../state/use-orchestration-command";
import {
  folderOfTags,
  orderFolders,
  planFolderTagChange,
  renameFolderInList,
} from "./legacySidebarFolders.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface PendingDraftFolder {
  readonly folder: string;
  readonly threadKey: string;
  readonly requestedAt: number;
}

interface LegacyFolderState {
  readonly folders: readonly string[];
  readonly collapsedFolders: readonly string[];
  readonly unfiledCollapsed: boolean;
  /** Folders picked for drafts by draft id; the tag is set once the thread exists. */
  readonly pendingDraftFolders: Readonly<Record<string, PendingDraftFolder>>;
}

const INITIAL_STATE: LegacyFolderState = {
  folders: [],
  collapsedFolders: [],
  unfiledCollapsed: false,
  pendingDraftFolders: {},
};

// A draft never sent keeps its entry this long; its thread id is unique, so a stale one is inert.
const PENDING_DRAFT_FOLDER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TAG_WRITE_CONCURRENCY = 6;

export const useLegacyFolderStore = create<LegacyFolderState>()(
  persist(() => INITIAL_STATE, {
    name: "t3code:legacy-sidebar-folders:v1",
    version: 1,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

export function folderOfThread(thread: Pick<EnvironmentThreadShell, "source">): string | null {
  return folderOfTags(thread.source.tags);
}

const UNFILED_ATOM_KEY = "";

// Folder rows subscribe to their own threads, so a change elsewhere doesn't re-render them.
const folderThreadShellsAtom = Atom.family((folderKey: string) => {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.threadShellsAtom).filter(
      (thread) => (folderOfThread(thread) ?? UNFILED_ATOM_KEY) === folderKey,
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`legacy-sidebar-folder-threads:${folderKey}`));
});

function folderNamesOf(threads: ReadonlyArray<EnvironmentThreadShell>): string[] {
  const names = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const folder = folderOfThread(thread);
    if (folder !== null) names.add(folder);
  }
  return [...names].toSorted();
}

let previousThreadFolderNames: readonly string[] = [];
const threadFolderNamesAtom = Atom.make((get) => {
  const next = folderNamesOf(get(environmentThreadShells.threadShellsAtom));
  if (arrayElementsEqual(previousThreadFolderNames, next)) return previousThreadFolderNames;
  previousThreadFolderNames = next;
  return next;
}).pipe(Atom.withLabel("legacy-sidebar-thread-folder-names"));

/** Threads tagged with `folder` (null: threads in no folder), archived ones included. */
export function useFolderThreadShells(
  folder: string | null,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(folderThreadShellsAtom(folder ?? UNFILED_ATOM_KEY));
}

/** Every folder in the user's order, with folders known only from thread tags after them. */
export function useFolderOrder(): string[] {
  const stored = useLegacyFolderStore((state) => state.folders);
  return orderFolders(stored, useAtomValue(threadFolderNamesAtom));
}

export function readFolderOrder(): string[] {
  return orderFolders(useLegacyFolderStore.getState().folders, folderNamesOf(readThreadShells()));
}

export function useFolderExpanded(folder: string | null): boolean {
  return useLegacyFolderStore((state) =>
    folder === null ? !state.unfiledCollapsed : !state.collapsedFolders.includes(folder),
  );
}

export function setFolderExpanded(folder: string | null, expanded: boolean): void {
  useLegacyFolderStore.setState((state) =>
    folder === null
      ? { unfiledCollapsed: !expanded }
      : {
          collapsedFolders: expanded
            ? state.collapsedFolders.filter((name) => name !== folder)
            : [...new Set([...state.collapsedFolders, folder])],
        },
  );
}

export function addFolders(names: readonly string[]): void {
  useLegacyFolderStore.setState((state) => {
    const missing = names.filter((name) => !state.folders.includes(name));
    return missing.length === 0 ? state : { folders: [...state.folders, ...new Set(missing)] };
  });
}

export function setFolderOrder(order: readonly string[]): void {
  useLegacyFolderStore.setState({ folders: [...order] });
}

export function threadsInFolder(folder: string): EnvironmentThreadShell[] {
  return readThreadShells().filter(
    (thread) => thread.archivedAt === null && folderOfThread(thread) === folder,
  );
}

async function setThreadTag(
  threadRef: ScopedThreadRef,
  tag: string,
  tagged: boolean,
): Promise<unknown> {
  if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) {
    return new Error(ORCHESTRATION_OPERATE_DENIED_MESSAGE);
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setTag,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tag, tagged },
    },
    { label: "thread folder tag", reportFailure: false },
  );
  return result._tag === "Success" || isAtomCommandInterrupted(result)
    ? null
    : squashAtomCommandFailure(result);
}

async function forEachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(TAG_WRITE_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await run(item);
    }
  });
  await Promise.all(lanes);
}

type FolderThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "source">;

/** Files threads in `folder` (null: in no folder). Returns whether every move worked. */
export function moveThreadsToFolder(
  threads: readonly FolderThread[],
  folder: string | null,
): Promise<boolean> {
  return fileThreads(threads.map((thread) => ({ thread, folder })));
}

/**
 * Files each thread in its folder. The new tag goes on before old ones come off, so a partial
 * failure leaves a thread in one of its folders. One toast reports every failure.
 */
export async function fileThreads(
  assignments: ReadonlyArray<{ readonly thread: FolderThread; readonly folder: string | null }>,
): Promise<boolean> {
  addFolders(assignments.flatMap(({ folder }) => (folder === null ? [] : [folder])));
  const failures: unknown[] = [];
  await forEachLimited(assignments, async ({ thread, folder }) => {
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    // The row may have been read before an earlier move landed.
    const tags = (readThreadShell(threadRef) ?? thread).source.tags;
    const change = planFolderTagChange(tags, folder);
    for (const [tag, tagged] of [
      ...(change.add === null ? [] : [[change.add, true] as const]),
      ...change.remove.map((tag) => [tag, false] as const),
    ]) {
      const failure = await setThreadTag(threadRef, tag, tagged);
      if (failure !== null) {
        failures.push(failure);
        return;
      }
    }
  });
  if (failures.length === 0) return true;
  const first = failures[0];
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title:
        assignments.length === 1
          ? "Could not move thread"
          : `Could not move ${failures.length} of ${assignments.length} threads`,
      description: first instanceof Error ? first.message : "An error occurred.",
    }),
  );
  return false;
}

/** Renames a folder on this device and retags its threads; a taken name merges the two. */
export async function renameFolder(from: string, to: string): Promise<void> {
  if (from === to) return;
  const threads = threadsInFolder(from);
  const order = readFolderOrder();
  useLegacyFolderStore.setState((state) => ({
    folders: renameFolderInList(order, from, to),
    collapsedFolders: state.collapsedFolders.includes(from)
      ? renameFolderInList(state.collapsedFolders, from, to)
      : state.collapsedFolders.filter((name) => name !== from),
    pendingDraftFolders: Object.fromEntries(
      Object.entries(state.pendingDraftFolders).map(([draftId, pending]) => [
        draftId,
        pending.folder === from ? { ...pending, folder: to } : pending,
      ]),
    ),
  }));
  await moveThreadsToFolder(threads, to);
}

/** Deletes a folder; its threads go to Unfiled. */
export async function deleteFolder(folder: string): Promise<void> {
  const threads = threadsInFolder(folder);
  useLegacyFolderStore.setState((state) => ({
    folders: state.folders.filter((name) => name !== folder),
    collapsedFolders: state.collapsedFolders.filter((name) => name !== folder),
    pendingDraftFolders: Object.fromEntries(
      Object.entries(state.pendingDraftFolders).filter(([, pending]) => pending.folder !== folder),
    ),
  }));
  await moveThreadsToFolder(threads, null);
}

/** Files the thread a draft becomes in `folder` once it exists (drafts become threads on send). */
export function rememberDraftFolder(draftId: string, threadRef: ScopedThreadRef, folder: string) {
  const now = Date.now();
  useLegacyFolderStore.setState((state) => ({
    pendingDraftFolders: {
      ...Object.fromEntries(
        Object.entries(state.pendingDraftFolders).filter(
          ([, pending]) => now - pending.requestedAt < PENDING_DRAFT_FOLDER_TTL_MS,
        ),
      ),
      [draftId]: { folder, threadKey: scopedThreadKey(threadRef), requestedAt: now },
    },
  }));
}

export function hasPendingDraftFolders(state: LegacyFolderState): boolean {
  return Object.keys(state.pendingDraftFolders).length > 0;
}

/**
 * Takes the pending folders whose threads now exist. `threadKeysOf` lists where a draft's
 * thread may be: the key saved with it, and the draft's current target.
 */
export function takeArrivedDraftFolders(
  threadKeysOf: (draftId: string, savedThreadKey: string) => readonly string[],
  threadExists: (threadKey: string) => boolean,
): Array<{ readonly threadKey: string; readonly folder: string }> {
  const arrived: Array<{ readonly threadKey: string; readonly folder: string }> = [];
  const remaining: Record<string, PendingDraftFolder> = {};
  for (const [draftId, pending] of Object.entries(
    useLegacyFolderStore.getState().pendingDraftFolders,
  )) {
    const threadKey = threadKeysOf(draftId, pending.threadKey).find(threadExists);
    if (threadKey === undefined) remaining[draftId] = pending;
    else arrived.push({ threadKey, folder: pending.folder });
  }
  if (arrived.length > 0) useLegacyFolderStore.setState({ pendingDraftFolders: remaining });
  return arrived;
}

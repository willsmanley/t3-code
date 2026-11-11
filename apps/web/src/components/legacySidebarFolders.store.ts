// Fork (F20): folder state and actions for the legacy sidebar. Membership is the thread tag
// `folder:<name>`, set through the existing `thread.tag.set` command. The folder list, collapse
// state and default folder live on each server (`threadFolders.*`); only folders picked for
// unsent drafts stay on this device.
import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createThreadFolderSettingsAtoms } from "@t3tools/client-runtime/state/thread-folder-settings";
import {
  type DeviceFolderState,
  findNewThreadProject,
  folderOfTags,
  type NewThreadProjectRef,
  planFolderTagChange,
  type ThreadFolderView,
} from "@t3tools/client-runtime/thread-folders";
import {
  AUTO_FILED_TAG,
  autoFileTagsOf,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  isAutoFiledThread,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadFolderUpdateInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { connectionAtomRuntime } from "../connection/runtime";
import { resolveStorage } from "../lib/storage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShell, readThreadShells, useProjects } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { ORCHESTRATION_OPERATE_DENIED_MESSAGE } from "../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const threadFolderSettings = createThreadFolderSettingsAtoms(connectionAtomRuntime, {
  serverConfigsAtom: environmentServerConfigsAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
});

interface PendingDraftFolder {
  /** null: the user started it in Unfiled, so the default folder doesn't apply. */
  readonly folder: string | null;
  readonly threadKey: string;
  readonly requestedAt: number;
}

interface DraftFolderState {
  /** Folders picked for drafts by draft id; sent with the draft's first message. */
  readonly pendingDraftFolders: Readonly<Record<string, PendingDraftFolder>>;
}

// A draft never sent keeps its entry this long; its thread id is unique, so a stale one is inert.
const PENDING_DRAFT_FOLDER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TAG_WRITE_CONCURRENCY = 6;
/** The per-device folder list from before servers kept folders; read once to migrate. */
const LEGACY_FOLDER_STORAGE_KEY = "t3code:legacy-sidebar-folders:v1";

const browserStorage = () =>
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

const decodeLegacyFolderState = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.Struct({
        folders: Schema.optional(Schema.Array(Schema.String)),
        collapsedFolders: Schema.optional(Schema.Array(Schema.String)),
        unfiledCollapsed: Schema.optional(Schema.Boolean),
        pendingDraftFolders: Schema.optional(
          Schema.Record(
            Schema.String,
            Schema.Struct({
              folder: Schema.String,
              threadKey: Schema.String,
              requestedAt: Schema.Number,
            }),
          ),
        ),
      }),
    }),
  ),
);

function readLegacyFolderState() {
  const raw = browserStorage().getItem(LEGACY_FOLDER_STORAGE_KEY);
  return typeof raw === "string" ? Option.getOrNull(decodeLegacyFolderState(raw)) : null;
}

/** This device's saved folder list, if it still has one to hand to the servers. */
export function readLegacyDeviceFolders(): DeviceFolderState | null {
  const legacy = readLegacyFolderState();
  if (legacy === null) return null;
  return {
    folders: legacy.state.folders ?? [],
    collapsed: legacy.state.collapsedFolders ?? [],
    unfiledCollapsed: legacy.state.unfiledCollapsed ?? false,
  };
}

export function forgetLegacyDeviceFolders(): void {
  browserStorage().removeItem(LEGACY_FOLDER_STORAGE_KEY);
}

export const useDraftFolderStore = create<DraftFolderState>()(
  persist(
    (): DraftFolderState => ({
      pendingDraftFolders: readLegacyFolderState()?.state.pendingDraftFolders ?? {},
    }),
    {
      name: "t3code:legacy-sidebar-draft-folders:v1",
      version: 1,
      storage: createJSONStorage(browserStorage),
    },
  ),
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

/** Threads tagged with `folder` (null: threads in no folder), archived ones included. */
export function useFolderThreadShells(
  folder: string | null,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(folderThreadShellsAtom(folder ?? UNFILED_ATOM_KEY));
}

export function useFolderView(): ThreadFolderView {
  return useAtomValue(threadFolderSettings.viewAtom);
}

/** False until every server that keeps folders has sent them. */
export function useFolderSettingsLoaded(): boolean {
  return useAtomValue(threadFolderSettings.loadedAtom);
}

function readFolderView(): ThreadFolderView {
  return appAtomRegistry.get(threadFolderSettings.viewAtom);
}

/** Every folder in the servers' order, with folders known only from thread tags after them. */
export function useFolderOrder(): readonly string[] {
  return useFolderView().folders;
}

export function readFolderOrder(): readonly string[] {
  return readFolderView().folders;
}

export function useFolderExpanded(folder: string | null): boolean {
  const view = useFolderView();
  return folder === null ? !view.unfiledCollapsed : !view.collapsed.has(folder);
}

function reportFolderFailure(title: string, failure: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: failure instanceof Error ? failure.message : "An error occurred.",
    }),
  );
}

async function updateFolders(
  change: ThreadFolderUpdateInput,
  failureTitle: string,
): Promise<{ readonly ok: boolean; readonly serverBacked: boolean }> {
  const outcome = await threadFolderSettings.apply(appAtomRegistry, change);
  if (outcome.failure !== null) reportFolderFailure(failureTitle, outcome.failure);
  else if (outcome.unmovedThreads > 0) {
    reportFolderFailure(
      failureTitle,
      new Error(
        `${outcome.unmovedThreads} thread${outcome.unmovedThreads === 1 ? "" : "s"} kept the old folder. Try again.`,
      ),
    );
  }
  return { ok: outcome.failure === null, serverBacked: outcome.serverBacked };
}

export function setFolderExpanded(folder: string | null, expanded: boolean): void {
  void updateFolders(
    { _tag: "setCollapsed", name: folder, collapsed: !expanded },
    "Could not save the folder",
  );
}

export function addFolders(names: readonly string[]): void {
  const listed = new Set(readFolderOrder());
  const missing = [...new Set(names)].filter((name) => !listed.has(name));
  if (missing.length === 0) return;
  void updateFolders({ _tag: "create", names: missing }, "Could not make the folder");
}

export function setFolderOrder(order: readonly string[]): void {
  void updateFolders({ _tag: "reorder", order }, "Could not save the folder order");
}

/** New threads started without a folder land in `folder` (null: in no folder). */
export function setDefaultFolder(folder: string | null): void {
  void updateFolders({ _tag: "setDefault", name: folder }, "Could not change the default folder");
}

/** Whether a new thread left in no folder is filed by the title model. */
export function setAutoFile(enabled: boolean): void {
  void updateFolders({ _tag: "setAutoFile", enabled }, "Could not change auto-filing");
}

/** Every new thread the user starts begins in `project` (null: each entry point picks). */
export async function setNewThreadProject(project: NewThreadProjectRef | null): Promise<void> {
  const outcome = await threadFolderSettings.setNewThreadProject(appAtomRegistry, project);
  if (outcome.failure !== null) {
    reportFolderFailure("Could not change where new threads start", outcome.failure);
  }
}

export function useNewThreadProjectRef(): NewThreadProjectRef | null {
  return useAtomValue(threadFolderSettings.newThreadProjectAtom);
}

/** The live project new threads start in, or null to keep each entry point's own choice. */
export function useNewThreadProject() {
  return findNewThreadProject(useNewThreadProjectRef(), useProjects());
}

export function readNewThreadProject() {
  return findNewThreadProject(
    appAtomRegistry.get(threadFolderSettings.newThreadProjectAtom),
    readProjects(),
  );
}

export function readNewThreadProjectRef(): ScopedProjectRef | null {
  const project = readNewThreadProject();
  return project === null ? null : scopeProjectRef(project.environmentId, project.id);
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
    // A move is the user's choice: it ends auto-filing's wait and clears its mark.
    for (const [tag, tagged] of [
      ...(change.add === null ? [] : [[change.add, true] as const]),
      ...change.remove.map((tag) => [tag, false] as const),
      ...autoFileTagsOf(tags).map((tag) => [tag, false] as const),
    ]) {
      const failure = await setThreadTag(threadRef, tag, tagged);
      if (failure !== null) {
        failures.push(failure);
        return;
      }
    }
  });
  if (failures.length === 0) return true;
  reportFolderFailure(
    assignments.length === 1
      ? "Could not move thread"
      : `Could not move ${failures.length} of ${assignments.length} threads`,
    failures[0],
  );
  return false;
}

/** Drops the "auto-filed" mark once the user has seen the thread's folder menu. */
export function clearAutoFileMarks(threads: readonly FolderThread[]): void {
  for (const thread of threads) {
    if (!isAutoFiledThread(thread.source.tags)) continue;
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) continue;
    void setThreadTag(scopeThreadRef(thread.environmentId, thread.id), AUTO_FILED_TAG, false);
  }
}

/** Loaded threads on servers that can't retag folders themselves (older servers, or none). */
function threadsServersWontRetag(folder: string): EnvironmentThreadShell[] {
  const retagging = new Set<EnvironmentId>(
    appAtomRegistry.get(threadFolderSettings.supportedEnvironmentIdsAtom),
  );
  return threadsInFolder(folder).filter((thread) => !retagging.has(thread.environmentId));
}

function renameDraftFolders(from: string, to: string | null) {
  useDraftFolderStore.setState((state) => ({
    pendingDraftFolders: Object.fromEntries(
      Object.entries(state.pendingDraftFolders).flatMap(([draftId, pending]) =>
        pending.folder !== from
          ? [[draftId, pending]]
          : to === null
            ? []
            : [[draftId, { ...pending, folder: to }]],
      ),
    ),
  }));
}

/** Renames a folder everywhere; servers retag every thread in it, archived ones too. */
export async function renameFolder(from: string, to: string): Promise<void> {
  if (from === to) return;
  const leftover = threadsServersWontRetag(from);
  renameDraftFolders(from, to);
  await updateFolders({ _tag: "rename", from, to }, "Could not rename the folder");
  if (leftover.length > 0) await moveThreadsToFolder(leftover, to);
}

/** Deletes a folder; its threads go to Unfiled. */
export async function deleteFolder(folder: string): Promise<void> {
  const leftover = threadsServersWontRetag(folder);
  renameDraftFolders(folder, null);
  await updateFolders({ _tag: "delete", name: folder }, "Could not delete the folder");
  if (leftover.length > 0) await moveThreadsToFolder(leftover, null);
}

/** The draft's thread starts in `folder` (null: in no folder) when its first message is sent. */
export function rememberDraftFolder(
  draftId: string,
  threadRef: ScopedThreadRef,
  folder: string | null,
) {
  const now = Date.now();
  useDraftFolderStore.setState((state) => ({
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

/** The folder picked for a draft, for the thread launch; nothing lets the server use its default. */
export function draftLaunchFolder(draftId: string | null): { readonly folder?: string | null } {
  const pending =
    draftId === null ? undefined : useDraftFolderStore.getState().pendingDraftFolders[draftId];
  return pending === undefined ? {} : { folder: pending.folder };
}

export function hasPendingDraftFolders(state: DraftFolderState): boolean {
  return Object.keys(state.pendingDraftFolders).length > 0;
}

/**
 * Takes the pending folders whose threads now exist. `threadKeysOf` lists where a draft's
 * thread may be: the key saved with it, and the draft's current target.
 */
export function takeArrivedDraftFolders(
  threadKeysOf: (draftId: string, savedThreadKey: string) => readonly string[],
  threadExists: (threadKey: string) => boolean,
): Array<{ readonly threadKey: string; readonly folder: string | null }> {
  const arrived: Array<{ readonly threadKey: string; readonly folder: string | null }> = [];
  const remaining: Record<string, PendingDraftFolder> = {};
  for (const [draftId, pending] of Object.entries(
    useDraftFolderStore.getState().pendingDraftFolders,
  )) {
    const threadKey = threadKeysOf(draftId, pending.threadKey).find(threadExists);
    if (threadKey === undefined) remaining[draftId] = pending;
    else arrived.push({ threadKey, folder: pending.folder });
  }
  if (arrived.length > 0) useDraftFolderStore.setState({ pendingDraftFolders: remaining });
  return arrived;
}

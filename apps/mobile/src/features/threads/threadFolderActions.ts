// Fork (F20): thread folders on the phone. A thread is in folder `X` when it has the thread tag
// `folder:X`, set with the existing `thread.tag.set` command, so desktop and phone show the same
// folders. The folder list, collapse state and default folder live on each server
// (`threadFolders.*`); only folders picked for unsent drafts stay on this device (preferences).
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createThreadFolderSettingsAtoms } from "@t3tools/client-runtime/state/thread-folder-settings";
import {
  type DeviceFolderState,
  folderNameProblem,
  folderOfTags,
  planFolderPerProject,
  planFolderTagChange,
} from "@t3tools/client-runtime/thread-folders";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  isListedThreadLineage,
  ThreadId,
  type ProjectId,
  type ThreadFolderUpdateInput,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { Preferences } from "../../persistence/mobile-preferences";
import type { PendingThreadFolder } from "../../persistence/thread-folder-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { rememberLaunchFolder } from "../../state/draftLaunchFolder";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

export const threadFolderSettings = createThreadFolderSettingsAtoms(connectionAtomRuntime, {
  serverConfigsAtom: environmentServerConfigsAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
});

type FolderThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "source">;

// A draft never sent keeps its entry this long; its request id is unique, so a stale one is inert.
const PENDING_DRAFT_FOLDER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TAG_WRITE_CONCURRENCY = 6;

function folderOfThread(thread: Pick<EnvironmentThreadShell, "source">): string | null {
  return folderOfTags(thread.source.tags);
}

function readPreferences(): Preferences | null {
  const result = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

function savePreferences(transform: (current: Preferences) => Partial<Preferences>): void {
  appAtomRegistry.set(updateMobilePreferencesAtom, { transform });
}

function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
}

/** Every folder in the servers' order, then folders known only from thread tags, by name. */
export const threadFolderOrderAtom = Atom.make(
  (get): readonly string[] => get(threadFolderSettings.viewAtom).folders,
).pipe(Atom.withLabel("mobile:thread-folders:order"));

function readFolderOrder(): readonly string[] {
  return appAtomRegistry.get(threadFolderOrderAtom);
}

async function updateFolders(change: ThreadFolderUpdateInput, failureTitle: string) {
  const outcome = await threadFolderSettings.apply(appAtomRegistry, change);
  if (outcome.failure !== null) {
    Dialog.alert(
      failureTitle,
      outcome.failure instanceof Error ? outcome.failure.message : "Try again.",
    );
  } else if (outcome.unmovedThreads > 0) {
    Dialog.alert(
      failureTitle,
      `${outcome.unmovedThreads} thread${outcome.unmovedThreads === 1 ? "" : "s"} kept the old folder. Try again.`,
    );
  }
  return outcome.failure === null;
}

function addFolders(names: readonly string[]): void {
  const listed = new Set(readFolderOrder());
  const missing = [...new Set(names)].filter((name) => !listed.has(name));
  if (missing.length === 0) return;
  void updateFolders({ _tag: "create", names: missing }, "Could not make the folder");
}

export function setFolderOrder(transform: (order: readonly string[]) => readonly string[]): void {
  void updateFolders(
    { _tag: "reorder", order: transform(readFolderOrder()) },
    "Could not save the folder order",
  );
}

export function toggleFolderCollapsed(folder: string | null): void {
  const view = appAtomRegistry.get(threadFolderSettings.viewAtom);
  const collapsed = folder === null ? view.unfiledCollapsed : view.collapsed.has(folder);
  void updateFolders(
    { _tag: "setCollapsed", name: folder, collapsed: !collapsed },
    "Could not save the folder",
  );
}

/** New threads started without a folder land in `folder` (null: in no folder). */
export function setDefaultFolder(folder: string | null): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  void updateFolders({ _tag: "setDefault", name: folder }, "Could not change the default folder");
}

/** This device's folder list from before servers kept folders, if it is still saved. */
export function legacyDeviceFolders(preferences: Preferences): DeviceFolderState | null {
  if (
    preferences.threadFolders === undefined &&
    preferences.collapsedThreadFolders === undefined &&
    preferences.unfiledThreadsCollapsed === undefined
  ) {
    return null;
  }
  return {
    folders: preferences.threadFolders ?? [],
    collapsed: preferences.collapsedThreadFolders ?? [],
    unfiledCollapsed: preferences.unfiledThreadsCollapsed ?? false,
  };
}

export function forgetLegacyDeviceFolders(): void {
  savePreferences(() => ({
    threadFolders: undefined,
    collapsedThreadFolders: undefined,
    unfiledThreadsCollapsed: undefined,
  }));
}

function threadsInFolder(folder: string): EnvironmentThreadShell[] {
  return readThreadShells().filter(
    (thread) => thread.archivedAt === null && folderOfThread(thread) === folder,
  );
}

function threadCountLabel(count: number) {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

async function setThreadTag(
  thread: FolderThread,
  tag: string,
  tagged: boolean,
): Promise<Error | null> {
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    return new Error("This connection cannot change threads.");
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setTag,
    { environmentId: thread.environmentId, input: { threadId: thread.id, tag, tagged } },
    { reportFailure: false },
  );
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error : new Error("Try again.");
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

/**
 * Files each thread in its folder (null: in no folder). The new tag goes on before old ones come
 * off, so a partial failure leaves a thread in one of its folders. One alert reports failures.
 */
async function fileThreads(
  assignments: ReadonlyArray<{ readonly thread: FolderThread; readonly folder: string | null }>,
): Promise<boolean> {
  if (assignments.length === 0) return true;
  addFolders(assignments.flatMap(({ folder }) => (folder === null ? [] : [folder])));
  const failures: Error[] = [];
  await forEachLimited(assignments, async ({ thread, folder }) => {
    // The row may have been read before an earlier move landed.
    const latest = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(scopeThreadRef(thread.environmentId, thread.id)),
    );
    const change = planFolderTagChange((latest ?? thread).source.tags, folder);
    for (const [tag, tagged] of [
      ...(change.add === null ? [] : [[change.add, true] as const]),
      ...change.remove.map((tag) => [tag, false] as const),
    ]) {
      const failure = await setThreadTag(thread, tag, tagged);
      if (failure !== null) {
        failures.push(failure);
        return;
      }
    }
  });
  if (failures.length === 0) return true;
  Dialog.alert(
    assignments.length === 1
      ? "Could not move thread"
      : `Could not move ${failures.length} of ${assignments.length} threads`,
    failures[0]!.message,
  );
  return false;
}

function moveThreadsToFolder(
  threads: readonly FolderThread[],
  folder: string | null,
): Promise<boolean> {
  return fileThreads(threads.map((thread) => ({ thread, folder })));
}

function promptFolderName(
  request: { readonly title: string; readonly message?: string; readonly confirmText: string },
  initialValue: string,
  onName: (name: string) => void,
): void {
  Dialog.prompt({
    ...request,
    placeholder: "Folder name",
    initialValue,
    onConfirm: (value) => {
      const problem = folderNameProblem(value);
      if (problem !== null) {
        Dialog.alert(request.title, problem);
        return;
      }
      onName(value.trim());
    },
  });
}

/** Asks for a name, makes the folder, and files `threads` in it. */
export function promptNewFolder(threads: readonly FolderThread[] = []): void {
  promptFolderName(
    {
      title: "New folder",
      ...(threads.length > 0
        ? { message: `${threadCountLabel(threads.length)} will move into it.` }
        : {}),
      confirmText: "Create",
    },
    "",
    (name) => {
      addFolders([name]);
      if (threads.length > 0) void moveThreadsToFolder(threads, name);
    },
  );
}

/** Loaded threads on servers that can't retag folders themselves (older servers, or none). */
function threadsServersWontRetag(folder: string): EnvironmentThreadShell[] {
  const retagging = new Set<EnvironmentId>(
    appAtomRegistry.get(threadFolderSettings.supportedEnvironmentIdsAtom),
  );
  return threadsInFolder(folder).filter((thread) => !retagging.has(thread.environmentId));
}

function renameDraftFolders(from: string, to: string | null) {
  savePreferences((current) => ({
    pendingThreadFolders: Object.fromEntries(
      Object.entries(current.pendingThreadFolders ?? {}).flatMap(([requestId, pending]) =>
        pending.folder !== from
          ? [[requestId, pending]]
          : to === null
            ? []
            : [[requestId, { ...pending, folder: to }]],
      ),
    ),
  }));
}

/** Renames a folder everywhere; servers retag every thread in it, archived ones too. */
async function renameFolder(from: string, to: string): Promise<void> {
  const leftover = threadsServersWontRetag(from);
  renameDraftFolders(from, to);
  await updateFolders({ _tag: "rename", from, to }, "Could not rename the folder");
  if (leftover.length > 0) await moveThreadsToFolder(leftover, to);
}

export function promptRenameFolder(folder: string): void {
  promptFolderName({ title: "Rename folder", confirmText: "Rename" }, folder, (name) => {
    if (name === folder) return;
    if (readFolderOrder().includes(name)) {
      Dialog.confirm({
        title: "Merge folders?",
        message: `A folder named "${name}" already exists. Move the threads in "${folder}" into it?`,
        confirmText: "Merge",
        onConfirm: () => void renameFolder(folder, name),
      });
      return;
    }
    void renameFolder(folder, name);
  });
}

/** Deletes a folder; its threads go to Unfiled. */
export function confirmDeleteFolder(folder: string): void {
  const remove = () => {
    const leftover = threadsServersWontRetag(folder);
    renameDraftFolders(folder, null);
    void updateFolders({ _tag: "delete", name: folder }, "Could not delete the folder").then(() =>
      leftover.length > 0 ? moveThreadsToFolder(leftover, null) : true,
    );
  };
  const count = threadsInFolder(folder).length;
  if (count === 0) {
    remove();
    return;
  }
  Dialog.confirm({
    title: `Delete folder "${folder}"?`,
    message: `Its ${threadCountLabel(count)} move to Unfiled. No thread is deleted.`,
    confirmText: "Delete",
    destructive: true,
    onConfirm: remove,
  });
}

/** The one-time start: a folder per project, with each listed thread filed under its project. */
export function confirmFolderPerProject(
  projects: ReadonlyArray<{
    readonly title: string;
    readonly archived: boolean;
    readonly projectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }>;
  }>,
): void {
  const threads = readThreadShells().filter(
    (thread) =>
      thread.archivedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      folderOfThread(thread) === null,
  );
  const plan = planFolderPerProject({
    projects: projects.map((project) => ({
      displayName: project.title,
      archived: project.archived,
      projectKeys: project.projectRefs.map((ref) =>
        scopedProjectKey(ref.environmentId, ref.projectId),
      ),
    })),
    threads,
    projectKeyOf: (thread) => scopedProjectKey(thread.environmentId, thread.projectId),
  });
  if (plan.folders.length === 0) return;
  Dialog.confirm({
    title: "Make a folder for each project?",
    message: `${plan.folders.length} folder${plan.folders.length === 1 ? "" : "s"}, with ${threadCountLabel(plan.assignments.length)} filed in them. Threads keep running in their own projects.`,
    confirmText: "Make folders",
    onConfirm: () => {
      addFolders(plan.folders);
      void fileThreads(plan.assignments);
    },
  });
}

/** The draft's thread starts in `folder` (null: in no folder); drafts become threads when sent. */
export function rememberDraftFolder(requestId: string, folder: string | null): void {
  const now = Date.now();
  savePreferences((current) => ({
    pendingThreadFolders: {
      ...Object.fromEntries(
        Object.entries(current.pendingThreadFolders ?? {}).filter(
          ([, pending]) => now - pending.requestedAt < PENDING_DRAFT_FOLDER_TTL_MS,
        ),
      ),
      [requestId]: { folder, requestedAt: now },
    },
  }));
}

function forgetDraftFolder(requestId: string): void {
  savePreferences((current) => {
    if (current.pendingThreadFolders?.[requestId] === undefined) return {};
    const { [requestId]: _sent, ...rest } = current.pendingThreadFolders;
    return { pendingThreadFolders: rest };
  });
}

const watchedDraftThreads = new Set<string>();

/** Tags a sent draft's thread once it shows up in the thread list. */
export function watchSentDraftFolder(requestId: string, pending: PendingThreadFolder): void {
  if (pending.thread === undefined || watchedDraftThreads.has(requestId)) return;
  watchedDraftThreads.add(requestId);
  const atom = environmentThreadShells.threadShellAtom(
    scopeThreadRef(
      EnvironmentId.make(pending.thread.environmentId),
      ThreadId.make(pending.thread.threadId),
    ),
  );
  let unsubscribe: (() => void) | null = null;
  const check = (shell: EnvironmentThreadShell | null) => {
    if (shell === null || !watchedDraftThreads.has(requestId)) return;
    watchedDraftThreads.delete(requestId);
    unsubscribe?.();
    // A rename or delete since the draft was sent changes or drops its folder. Servers that take
    // a launch folder already filed the thread; older ones need the tags set here.
    const folder = readPreferences()?.pendingThreadFolders?.[requestId]?.folder;
    forgetDraftFolder(requestId);
    if (folder !== undefined && folderOfThread(shell) !== folder) {
      void moveThreadsToFolder([shell], folder);
    }
  };
  unsubscribe = appAtomRegistry.subscribe(atom, check);
  check(appAtomRegistry.get(atom));
}

/** Called when a draft is sent; files its thread if the draft was started from a folder. */
export function fileSentDraftInFolder(
  routeParams: object | undefined,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  const requestId = (
    routeParams as { readonly draft?: { readonly requestId?: string } } | undefined
  )?.draft?.requestId;
  if (requestId === undefined) return;
  const pending = readPreferences()?.pendingThreadFolders?.[requestId];
  if (pending === undefined) return;
  rememberLaunchFolder(environmentId, threadId, pending.folder);
  const sent = { ...pending, thread: { environmentId, threadId } };
  savePreferences((current) =>
    current.pendingThreadFolders?.[requestId] === undefined
      ? {}
      : { pendingThreadFolders: { ...current.pendingThreadFolders, [requestId]: sent } },
  );
  watchSentDraftFolder(requestId, sent);
}

/** "Move to folder" and "Remove from folder" for a thread's menu; `handle` says if it took the event. */
export function threadFolderMenu(thread: FolderThread, folders: readonly string[]) {
  const current = folderOfThread(thread);
  const actions: MenuAction[] = [
    {
      id: "folder-move",
      title: "Move to folder",
      image: "folder",
      subactions: [
        ...folders.map((name, index): MenuAction => ({
          id: `folder-move:${index}`,
          title: name,
          state: current === name ? "on" : "off",
        })),
        { id: "folder-new", title: "New folder…", image: "folder.badge.plus" },
      ],
    },
    ...(current === null
      ? []
      : [{ id: "folder-remove", title: "Remove from folder", image: "tray.and.arrow.up" }]),
  ];
  const move = (folder: string | null) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void moveThreadsToFolder([thread], folder);
  };
  const handle = (event: string): boolean => {
    if (event === "folder-new") {
      promptNewFolder([thread]);
      return true;
    }
    if (event === "folder-remove") {
      move(null);
      return true;
    }
    if (!event.startsWith("folder-move:")) return false;
    const folder = folders[Number(event.slice("folder-move:".length))];
    if (folder !== undefined) move(folder);
    return true;
  };
  return { actions, handle } as const;
}

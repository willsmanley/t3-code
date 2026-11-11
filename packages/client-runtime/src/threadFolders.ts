// Fork (F20): thread folders, shared by the desktop sidebar and the phone app. A thread's folder
// is an ordinary thread tag, `folder:<name>`. Each server keeps its folder list (order, collapse
// state, empty folders) and default folder; `resolveThreadFolderView` merges them for display.
import {
  type EnvironmentId,
  MAX_THREAD_FOLDER_NAME_LENGTH,
  planThreadFolderTagChange,
  type ThreadFolderSettings,
  type ThreadFolderTagChange,
  type ThreadFolderUpdateInput,
  threadFolderOfTags,
} from "@t3tools/contracts";

const CONTROL_CHARACTER = /[\p{Cc}]/u;
const CONTROL_CHARACTERS = /[\p{Cc}]+/gu;

/** Why a typed folder name can't be used, or null when it can (after trimming). */
export function folderNameProblem(input: string): string | null {
  const name = input.trim();
  if (name.length === 0) return "Enter a folder name.";
  if (name.length > MAX_THREAD_FOLDER_NAME_LENGTH) {
    return `Folder names can be at most ${MAX_THREAD_FOLDER_NAME_LENGTH} characters.`;
  }
  if (CONTROL_CHARACTER.test(name)) return "A folder name must be a single line.";
  return null;
}

/** A thread's folder: its last folder tag, the one the server added most recently. */
export const folderOfTags = threadFolderOfTags;

export type FolderTagChange = ThreadFolderTagChange;

/**
 * The tag changes that put a thread in `folder` (null for no folder) and out of every other.
 * Apply `add` before `remove`, so a half-finished move leaves the thread in one folder.
 */
export const planFolderTagChange = planThreadFolderTagChange;

/** The user's folders in their order, then folders only threads know about, by name. */
export function orderFolders(stored: readonly string[], fromThreads: Iterable<string>): string[] {
  const ordered = [...new Set(stored)];
  const known = new Set(ordered);
  const extra = [...new Set(fromThreads)]
    .filter((name) => !known.has(name))
    .sort((left, right) => left.localeCompare(right));
  return [...ordered, ...extra];
}

export interface FolderGroup<T> {
  readonly folder: string;
  readonly threads: readonly T[];
}

/** Every folder in order (empty ones too), and the threads in no folder. Thread order is kept. */
export function groupByFolder<T>(
  threads: readonly T[],
  folderOf: (thread: T) => string | null,
  order: readonly string[],
): { readonly folders: FolderGroup<T>[]; readonly unfiled: T[] } {
  const byFolder = new Map<string, T[]>(order.map((name) => [name, []]));
  const unfiled: T[] = [];
  for (const thread of threads) {
    const folder = folderOf(thread);
    if (folder === null) {
      unfiled.push(thread);
      continue;
    }
    const list = byFolder.get(folder);
    if (list) list.push(thread);
    else byFolder.set(folder, [thread]);
  }
  return {
    folders: [...byFolder.entries()].map(([folder, folderThreads]) => ({
      folder,
      threads: folderThreads,
    })),
    unfiled,
  };
}

/** Moves `active` to where `over` sits, as a drag in a sorted list does. */
export function moveFolder(order: readonly string[], active: string, over: string): string[] {
  const from = order.indexOf(active);
  const to = order.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, active);
  return next;
}

/** Renames a folder in place; renaming onto an existing folder merges into that one. */
export function renameFolderInList(list: readonly string[], from: string, to: string): string[] {
  if (from === to) return [...list];
  if (list.includes(to)) return list.filter((name) => name !== from);
  return list.map((name) => (name === from ? to : name));
}

/** A project's display name as a usable folder name. */
export function folderNameForProject(displayName: string): string {
  const name = displayName
    .replace(CONTROL_CHARACTERS, " ")
    .trim()
    .slice(0, MAX_THREAD_FOLDER_NAME_LENGTH)
    .trim();
  return name.length > 0 ? name : "Untitled project";
}

export interface FolderPerProjectPlan<T> {
  readonly folders: string[];
  readonly assignments: ReadonlyArray<{ readonly thread: T; readonly folder: string }>;
}

/**
 * One folder per project, in project order, with each thread filed under its project's folder.
 * Projects whose names match share a folder; an archived project only gets one for its threads.
 */
export function planFolderPerProject<T>(input: {
  readonly projects: ReadonlyArray<{
    readonly displayName: string;
    readonly archived: boolean;
    readonly projectKeys: readonly string[];
  }>;
  readonly threads: readonly T[];
  readonly projectKeyOf: (thread: T) => string;
}): FolderPerProjectPlan<T> {
  const folderByProjectKey = new Map<string, string>();
  for (const project of input.projects) {
    const folder = folderNameForProject(project.displayName);
    for (const key of project.projectKeys) folderByProjectKey.set(key, folder);
  }
  const assignments = input.threads.flatMap((thread) => {
    const folder = folderByProjectKey.get(input.projectKeyOf(thread));
    return folder === undefined ? [] : [{ thread, folder }];
  });
  const filed = new Set(assignments.map((assignment) => assignment.folder));
  const folders = input.projects
    .filter((project) => !project.archived || filed.has(folderNameForProject(project.displayName)))
    .map((project) => folderNameForProject(project.displayName));
  return { folders: [...new Set(folders)], assignments };
}

/**
 * The project for a new thread in a folder: that of the folder's most recently active thread,
 * else the current thread's, else the first project.
 */
export function chooseFolderThreadProject<R>(input: {
  readonly folderThreads: ReadonlyArray<{ readonly project: R; readonly activeAt: string }>;
  readonly current: R | null;
  readonly first: R | null;
}): R | null {
  let latest: { readonly project: R; readonly at: number } | null = null;
  for (const thread of input.folderThreads) {
    const at = Date.parse(thread.activeAt);
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest.at) latest = { project: thread.project, at };
  }
  return latest?.project ?? input.current ?? input.first;
}

/** Folder state kept on this device for a session when no connected server keeps folders. */
export interface SessionFolderState {
  readonly folders: readonly string[];
  readonly collapsed: readonly string[];
  readonly unfiledCollapsed: boolean;
}

export const EMPTY_SESSION_FOLDER_STATE: SessionFolderState = {
  folders: [],
  collapsed: [],
  unfiledCollapsed: false,
};

export interface ThreadFolderView {
  /** Every folder in order: the servers' lists, then folders only thread tags know, by name. */
  readonly folders: readonly string[];
  readonly collapsed: ReadonlySet<string>;
  readonly unfiledCollapsed: boolean;
  /** Where a new thread the user starts without picking a folder lands. */
  readonly defaultFolder: string | null;
  /** False when no connected server keeps folders, so the list lasts only this session. */
  readonly serverBacked: boolean;
}

function changedAt(settings: ThreadFolderSettings): number {
  if (settings.updatedAt === null) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(settings.updatedAt);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * One view over every connected server's folder settings. The server a user changed most
 * recently leads; lists only seeded from tags come last, and the others add their folders after.
 */
export function resolveThreadFolderView(input: {
  readonly servers: ReadonlyArray<ThreadFolderSettings>;
  readonly fromThreads: Iterable<string>;
  readonly session: SessionFolderState;
}): ThreadFolderView {
  if (input.servers.length === 0) {
    return {
      folders: orderFolders(input.session.folders, input.fromThreads),
      collapsed: new Set(input.session.collapsed),
      unfiledCollapsed: input.session.unfiledCollapsed,
      defaultFolder: null,
      serverBacked: false,
    };
  }
  const ranked = [...input.servers].sort((left, right) => changedAt(right) - changedAt(left));
  const lead = ranked[0]!;
  const listed: string[] = [];
  const collapsed = new Set<string>();
  const seen = new Set<string>();
  for (const settings of ranked) {
    for (const entry of settings.folders) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      listed.push(entry.name);
      if (entry.collapsed) collapsed.add(entry.name);
    }
  }
  return {
    folders: orderFolders(listed, input.fromThreads),
    collapsed,
    unfiledCollapsed: lead.unfiledCollapsed,
    defaultFolder: lead.defaultFolder,
    serverBacked: true,
  };
}

export function threadFolderViewsEqual(left: ThreadFolderView, right: ThreadFolderView): boolean {
  return (
    left.unfiledCollapsed === right.unfiledCollapsed &&
    left.defaultFolder === right.defaultFolder &&
    left.serverBacked === right.serverBacked &&
    left.folders.length === right.folders.length &&
    left.folders.every((name, index) => right.folders[index] === name) &&
    left.collapsed.size === right.collapsed.size &&
    [...left.collapsed].every((name) => right.collapsed.has(name))
  );
}

/** Folders a device saved before servers kept them. */
export interface DeviceFolderState {
  readonly folders: readonly string[];
  readonly collapsed: readonly string[];
  readonly unfiledCollapsed: boolean;
}

export type DeviceFolderMigrationStep =
  | { readonly type: "wait" }
  | { readonly type: "forget" }
  | {
      readonly type: "push";
      readonly environmentIds: readonly EnvironmentId[];
      readonly update: Extract<ThreadFolderUpdateInput, { readonly _tag: "seedFromDevice" }>;
    };

/**
 * What to do with a device's saved folders. While every server that keeps folders still has only
 * the list it read from thread tags, the device's order goes to all of them once; after any user
 * change on any of them it is dropped. With no such server connected it waits.
 */
export function deviceFolderMigrationStep(input: {
  readonly device: DeviceFolderState;
  readonly environmentIds: readonly EnvironmentId[];
  readonly settings: ReadonlyMap<EnvironmentId, ThreadFolderSettings>;
}): DeviceFolderMigrationStep {
  if (input.environmentIds.length === 0) return { type: "wait" };
  const loaded = input.environmentIds.flatMap((id) => {
    const settings = input.settings.get(id);
    return settings === undefined ? [] : [settings];
  });
  if (loaded.length < input.environmentIds.length) return { type: "wait" };
  const usable = (names: readonly string[]) =>
    [...new Set(names.map((name) => name.trim()))].filter(
      (name) => folderNameProblem(name) === null,
    );
  const order = usable(input.device.folders);
  if (
    loaded.some((settings) => settings.updatedAt !== null) ||
    (order.length === 0 && !input.device.unfiledCollapsed)
  ) {
    return { type: "forget" };
  }
  return {
    type: "push",
    environmentIds: input.environmentIds,
    update: {
      _tag: "seedFromDevice",
      order,
      collapsed: usable(input.device.collapsed),
      unfiledCollapsed: input.device.unfiledCollapsed,
    },
  };
}

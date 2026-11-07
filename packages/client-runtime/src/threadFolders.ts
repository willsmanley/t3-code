// Fork (F20): thread folders, shared by the desktop sidebar and the phone app. A thread's folder
// is an ordinary thread tag, `folder:<name>`; folder order and empty folders are per-device state.

const FOLDER_TAG_PREFIX = "folder:";
/** Thread tags hold at most 64 characters; this leaves room for the prefix. */
const MAX_FOLDER_NAME_LENGTH = 56;

const CONTROL_CHARACTER = /[\p{Cc}]/u;
const CONTROL_CHARACTERS = /[\p{Cc}]+/gu;

/** Why a typed folder name can't be used, or null when it can (after trimming). */
export function folderNameProblem(input: string): string | null {
  const name = input.trim();
  if (name.length === 0) return "Enter a folder name.";
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return `Folder names can be at most ${MAX_FOLDER_NAME_LENGTH} characters.`;
  }
  if (CONTROL_CHARACTER.test(name)) return "A folder name must be a single line.";
  return null;
}

function folderTag(name: string): string {
  return `${FOLDER_TAG_PREFIX}${name}`;
}

function folderNameOfTag(tag: string): string | null {
  if (!tag.startsWith(FOLDER_TAG_PREFIX)) return null;
  const name = tag.slice(FOLDER_TAG_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/** A thread's folder: its last folder tag, the one the server added most recently. */
export function folderOfTags(tags: ReadonlyArray<string> | undefined): string | null {
  if (!tags) return null;
  for (let index = tags.length - 1; index >= 0; index--) {
    const name = folderNameOfTag(tags[index]!);
    if (name !== null) return name;
  }
  return null;
}

export interface FolderTagChange {
  readonly add: string | null;
  readonly remove: readonly string[];
}

/**
 * The tag changes that put a thread in `folder` (null for no folder) and out of every other.
 * Apply `add` before `remove`, so a half-finished move leaves the thread in one folder.
 */
export function planFolderTagChange(
  tags: ReadonlyArray<string> | undefined,
  folder: string | null,
): FolderTagChange {
  const target = folder === null ? null : folderTag(folder);
  const current = (tags ?? []).filter((tag) => folderNameOfTag(tag) !== null);
  return {
    add: target !== null && !current.includes(target) ? target : null,
    remove: current.filter((tag) => tag !== target),
  };
}

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
    .slice(0, MAX_FOLDER_NAME_LENGTH)
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

import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork (F20): thread folders. A thread is in folder `X` when it carries the thread tag
// `folder:X`. The server keeps the folder list (order, collapse state, empty folders) and the
// folder new threads land in, so every client shows the same folders.

const FOLDER_TAG_PREFIX = "folder:";
/** Thread tags hold at most 64 characters; this leaves room for the prefix. */
export const MAX_THREAD_FOLDER_NAME_LENGTH = 56;
const CONTROL_CHARACTER = /[\p{Cc}]/u;

export const ThreadFolderName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_THREAD_FOLDER_NAME_LENGTH),
  Schema.makeFilter((value) =>
    CONTROL_CHARACTER.test(value) ? "A folder name must be a single line." : true,
  ),
);
export type ThreadFolderName = typeof ThreadFolderName.Type;

export function threadFolderTag(name: string): string {
  return `${FOLDER_TAG_PREFIX}${name}`;
}

function folderNameOfTag(tag: string): string | null {
  if (!tag.startsWith(FOLDER_TAG_PREFIX)) return null;
  const name = tag.slice(FOLDER_TAG_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/** A thread's folder: its last folder tag, the one the server added most recently. */
export function threadFolderOfTags(tags: ReadonlyArray<string> | undefined): string | null {
  if (!tags) return null;
  for (let index = tags.length - 1; index >= 0; index--) {
    const name = folderNameOfTag(tags[index]!);
    if (name !== null) return name;
  }
  return null;
}

export interface ThreadFolderTagChange {
  readonly add: string | null;
  readonly remove: readonly string[];
}

/**
 * The tag changes that put a thread in `folder` (null for no folder) and out of every other.
 * Apply `add` before `remove`, so a half-finished move leaves the thread in one folder.
 */
export function planThreadFolderTagChange(
  tags: ReadonlyArray<string> | undefined,
  folder: string | null,
): ThreadFolderTagChange {
  const target = folder === null ? null : threadFolderTag(folder);
  const current = (tags ?? []).filter((tag) => folderNameOfTag(tag) !== null);
  return {
    add: target !== null && !current.includes(target) ? target : null,
    remove: current.filter((tag) => tag !== target),
  };
}

export const ThreadFolderEntry = Schema.Struct({
  name: ThreadFolderName,
  collapsed: Schema.Boolean,
});
export type ThreadFolderEntry = typeof ThreadFolderEntry.Type;

export const ThreadFolderSettings = Schema.Struct({
  /** In the user's order, empty folders included. */
  folders: Schema.Array(ThreadFolderEntry),
  /** Where a thread the user starts without picking a folder lands. */
  defaultFolder: Schema.NullOr(ThreadFolderName),
  unfiledCollapsed: Schema.Boolean,
  /** The last change a user made; null while the list only holds folders read from thread tags. */
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadFolderSettings = typeof ThreadFolderSettings.Type;

/** `name: null` in `setCollapsed` is Unfiled. Rename and delete retag every thread, archived too. */
export const ThreadFolderUpdateInput = Schema.Union([
  Schema.TaggedStruct("create", { names: Schema.Array(ThreadFolderName) }),
  Schema.TaggedStruct("rename", { from: ThreadFolderName, to: ThreadFolderName }),
  Schema.TaggedStruct("delete", { name: ThreadFolderName }),
  Schema.TaggedStruct("reorder", { order: Schema.Array(ThreadFolderName) }),
  Schema.TaggedStruct("setCollapsed", {
    name: Schema.NullOr(ThreadFolderName),
    collapsed: Schema.Boolean,
  }),
  Schema.TaggedStruct("setDefault", { name: Schema.NullOr(ThreadFolderName) }),
  /** A device's saved folders from before the server kept them; used only while `updatedAt` is null. */
  Schema.TaggedStruct("seedFromDevice", {
    order: Schema.Array(ThreadFolderName),
    collapsed: Schema.Array(ThreadFolderName),
    unfiledCollapsed: Schema.Boolean,
  }),
]);
export type ThreadFolderUpdateInput = typeof ThreadFolderUpdateInput.Type;

export const ThreadFolderUpdateResult = Schema.Struct({
  settings: ThreadFolderSettings,
  /** Threads a rename or delete could not retag. */
  unmovedThreads: NonNegativeInt,
});
export type ThreadFolderUpdateResult = typeof ThreadFolderUpdateResult.Type;

function entriesInOrder(
  order: ReadonlyArray<string>,
  current: ReadonlyArray<ThreadFolderEntry>,
  collapsedOf: (name: string, existing: ThreadFolderEntry | undefined) => boolean,
): ThreadFolderEntry[] {
  const byName = new Map(current.map((entry) => [entry.name, entry]));
  const named = [...new Set(order)];
  const listed = new Set(named);
  return [
    ...named.map((name) => ({ name, collapsed: collapsedOf(name, byName.get(name)) })),
    ...current.filter((entry) => !listed.has(entry.name)),
  ];
}

function withFolder(
  folders: ReadonlyArray<ThreadFolderEntry>,
  name: string,
  collapsed = false,
): ReadonlyArray<ThreadFolderEntry> {
  return folders.some((entry) => entry.name === name) ? folders : [...folders, { name, collapsed }];
}

/** The settings after `input`, or the same object when nothing changes. Retagging is separate. */
export function applyThreadFolderUpdate(
  settings: ThreadFolderSettings,
  input: ThreadFolderUpdateInput,
  now: string,
): ThreadFolderSettings {
  const changed = (next: Omit<ThreadFolderSettings, "updatedAt">): ThreadFolderSettings => ({
    ...next,
    updatedAt: now,
  });
  switch (input._tag) {
    case "create": {
      const missing = [...new Set(input.names)].filter(
        (name) => !settings.folders.some((entry) => entry.name === name),
      );
      if (missing.length === 0) return settings;
      return changed({
        ...settings,
        folders: [...settings.folders, ...missing.map((name) => ({ name, collapsed: false }))],
      });
    }
    case "rename": {
      if (input.from === input.to) return settings;
      const target = settings.folders.find((entry) => entry.name === input.to);
      const folders =
        target !== undefined
          ? settings.folders.filter((entry) => entry.name !== input.from)
          : settings.folders.some((entry) => entry.name === input.from)
            ? settings.folders.map((entry) =>
                entry.name === input.from ? { ...entry, name: input.to } : entry,
              )
            : [...settings.folders, { name: input.to, collapsed: false }];
      return changed({
        ...settings,
        folders,
        defaultFolder: settings.defaultFolder === input.from ? input.to : settings.defaultFolder,
      });
    }
    case "delete":
      return changed({
        ...settings,
        folders: settings.folders.filter((entry) => entry.name !== input.name),
        defaultFolder: settings.defaultFolder === input.name ? null : settings.defaultFolder,
      });
    case "reorder":
      return changed({
        ...settings,
        folders: entriesInOrder(input.order, settings.folders, (_, existing) =>
          existing === undefined ? false : existing.collapsed,
        ),
      });
    case "setCollapsed":
      if (input.name === null) return changed({ ...settings, unfiledCollapsed: input.collapsed });
      return changed({
        ...settings,
        folders: withFolder(settings.folders, input.name, input.collapsed).map((entry) =>
          entry.name === input.name ? { ...entry, collapsed: input.collapsed } : entry,
        ),
      });
    case "setDefault":
      return changed({
        ...settings,
        folders: input.name === null ? settings.folders : withFolder(settings.folders, input.name),
        defaultFolder: input.name,
      });
    case "seedFromDevice": {
      if (settings.updatedAt !== null) return settings;
      const collapsed = new Set(input.collapsed);
      return changed({
        ...settings,
        folders: entriesInOrder(input.order, settings.folders, (name) => collapsed.has(name)).map(
          (entry) => ({ ...entry, collapsed: collapsed.has(entry.name) }),
        ),
        unfiledCollapsed: input.unfiledCollapsed,
      });
    }
  }
}

export class ThreadFolderError extends Schema.TaggedError<ThreadFolderError>()(
  "ThreadFolderError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

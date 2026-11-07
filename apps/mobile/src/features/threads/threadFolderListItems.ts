// Fork (F20): list items of the Android thread tree, which groups threads by folder.
import type { ThreadStatusDotKind } from "./projectThreadTree";

/** A folder header; `folder` null is Unfiled, the threads in no folder. */
export interface ThreadListV2FolderHeaderListItem {
  readonly type: "v2-folder";
  readonly key: string;
  readonly folder: string | null;
  readonly threadCount: number;
  readonly collapsed: boolean;
  /** The most urgent thread status, shown only while the folder is collapsed. */
  readonly status: ThreadStatusDotKind | null;
  /** The environment project of the folder's most recently active thread, for New thread. */
  readonly newThreadProjectKey: string | null;
  /** The neighbouring folders, which Move up and Move down place this one past. */
  readonly previousFolder: string | null;
  readonly nextFolder: string | null;
  /** There are two folders or more to arrange. */
  readonly canArrange: boolean;
  /** Unfiled offers a folder per project until the first folder exists. */
  readonly offerFolderPerProject: boolean;
  /**
   * Carried on the item because a recycled cell ignores the render closure, so
   * the header must re-render once the folder preferences load.
   */
  readonly disabled: boolean;
}

export interface ThreadListV2FolderMoreListItem {
  readonly type: "v2-folder-more";
  readonly key: string;
  readonly folder: string | null;
  readonly hiddenCount: number;
  readonly expanded: boolean;
}

/** A folder inside the Workers shelf. */
export interface ThreadListV2WorkerFolderListItem {
  readonly type: "v2-worker-folder";
  readonly key: string;
  readonly folder: string | null;
  readonly count: number;
  readonly collapsed: boolean;
}

export type ThreadFolderTreeListItem =
  | ThreadListV2FolderHeaderListItem
  | ThreadListV2FolderMoreListItem
  | ThreadListV2WorkerFolderListItem;

/** A folder's key in collapse and "show more" state. Folder names never contain a newline. */
export function folderGroupKey(folder: string | null): string {
  return folder === null ? "unfiled" : `folder:${folder}`;
}

export function isThreadFolderTreeListItem(value: {
  readonly type: string;
}): value is ThreadFolderTreeListItem {
  return (
    value.type === "v2-folder" ||
    value.type === "v2-folder-more" ||
    value.type === "v2-worker-folder"
  );
}

export function threadFolderTreeListItemsAreEqual(
  previous: { readonly type: string },
  item: ThreadFolderTreeListItem,
): boolean {
  if (!isThreadFolderTreeListItem(previous)) return false;
  switch (item.type) {
    case "v2-folder":
      return (
        previous.type === "v2-folder" &&
        previous.key === item.key &&
        previous.threadCount === item.threadCount &&
        previous.collapsed === item.collapsed &&
        previous.status === item.status &&
        previous.newThreadProjectKey === item.newThreadProjectKey &&
        previous.previousFolder === item.previousFolder &&
        previous.nextFolder === item.nextFolder &&
        previous.canArrange === item.canArrange &&
        previous.offerFolderPerProject === item.offerFolderPerProject &&
        previous.disabled === item.disabled
      );
    case "v2-folder-more":
      return (
        previous.type === "v2-folder-more" &&
        previous.key === item.key &&
        previous.hiddenCount === item.hiddenCount &&
        previous.expanded === item.expanded
      );
    case "v2-worker-folder":
      return (
        previous.type === "v2-worker-folder" &&
        previous.key === item.key &&
        previous.count === item.count &&
        previous.collapsed === item.collapsed
      );
  }
}

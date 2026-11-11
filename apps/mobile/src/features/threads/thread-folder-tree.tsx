// Fork (F20): the folder parts of the Android thread tree, shared by the home list and the
// tablet sidebar: grouping, folder headers and their actions, and the arrange sheet.
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { FolderArrangementSheet } from "./FolderArrangementSheet";
import {
  ThreadFolderHeader,
  ThreadTreeMoreRow,
  type ThreadFolderHeaderAction,
} from "./project-thread-tree-items";
import { buildFolderThreadTreeListItems } from "./projectThreadTree";
import {
  confirmDeleteFolder,
  confirmFolderPerProject,
  promptNewFolder,
  promptRenameFolder,
  readNewThreadProject,
  rememberDraftFolder,
  setAutoFile,
  setDefaultFolder,
} from "./threadFolderActions";
import type {
  ThreadFolderTreeListItem,
  ThreadListV2FolderHeaderListItem,
} from "./threadFolderListItems";
import type { ThreadListV2ListItem } from "./threadListV2";
import { useThreadFolderTreeState } from "./use-thread-folders";

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * `tab` is Android's bottom tab (F18). Workers lists only folders that hold a worker, plus Unfiled
 * for its New folder button, and has no new-thread buttons or folder-per-project offer;
 * collapsing a folder there collapses it everywhere.
 */
export function useThreadFolderTree(input: {
  readonly tab: "projects" | "workers";
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly selectedThreadKey: string | null;
  /** Searching opens every folder and lists only folders with matches. */
  readonly searching: boolean;
  /** A project or environment filter lists only folders with threads. */
  readonly filtered: boolean;
  readonly pane: "screen" | "sidebar";
  readonly onNewThreadInProject: (project: EnvironmentProject, requestId?: string) => void;
}) {
  const state = useThreadFolderTreeState();
  const projectsTab = input.tab === "projects";
  const { projects, projectGroupingMode } = input;
  const projectScopes = () =>
    buildHomeProjectScopes({ projects, environmentId: null, projectGroupingMode });

  const groupListItems = (listItems: ReadonlyArray<ThreadListV2ListItem>) =>
    buildFolderThreadTreeListItems({
      listItems,
      folderOrder: state.folderOrder,
      collapsedGroupKeys: input.searching ? NO_KEYS : state.collapsedGroupKeys,
      expandedGroupKeys: state.expandedGroupKeys,
      showEmptyFolders: projectsTab && !input.searching && !input.filtered,
      showUnfiled: !input.searching && !input.filtered,
      offerFolderPerProject: projectsTab,
      selectedThreadKey: input.selectedThreadKey,
      preferencesLoading: !state.loaded,
    });

  // The server's new-thread project, else the folder's most recently active project, else the
  // first project; filed once it is sent.
  const startThreadInFolder = (item: ThreadListV2FolderHeaderListItem) => {
    const latest =
      readNewThreadProject() ??
      projects.find(
        (project) =>
          project.archivedAt == null &&
          scopedProjectKey(project.environmentId, project.id) === item.newThreadProjectKey,
      );
    const project = latest ?? pickableProjectGroups(projectScopes())[0]?.representative;
    if (project === undefined) return;
    const requestId = uuidv4();
    rememberDraftFolder(requestId, item.folder);
    input.onNewThreadInProject(project, requestId);
  };

  const handleAction = (
    item: ThreadListV2FolderHeaderListItem,
    action: ThreadFolderHeaderAction,
  ) => {
    const { folder } = item;
    if (action === "new-folder") promptNewFolder();
    if (action === "arrange") state.openFolderArrangement();
    if (action === "folder-per-project") confirmFolderPerProject(projectScopes());
    if (action === "auto-file") setAutoFile(!state.autoFile);
    if (folder === null) return;
    if (action === "rename") promptRenameFolder(folder);
    if (action === "default") setDefaultFolder(state.defaultFolder === folder ? null : folder);
    if (action === "delete") confirmDeleteFolder(folder);
    if (action === "move-up" && item.previousFolder !== null) {
      state.moveFolder(folder, { target: item.previousFolder, placement: "before" });
    }
    if (action === "move-down" && item.nextFolder !== null) {
      state.moveFolder(folder, { target: item.nextFolder, placement: "after" });
    }
  };

  const renderItem = (item: ThreadFolderTreeListItem) => {
    switch (item.type) {
      case "v2-folder":
        return (
          <ThreadFolderHeader
            folder={item.folder}
            threadCount={item.threadCount}
            collapsed={item.collapsed}
            status={item.status}
            canMoveUp={item.previousFolder !== null}
            canMoveDown={item.nextFolder !== null}
            canArrange={item.canArrange}
            offerFolderPerProject={item.offerFolderPerProject}
            isDefault={item.folder !== null && item.folder === state.defaultFolder}
            canSetDefault={state.serverBacked}
            autoFile={state.serverBacked ? state.autoFile : undefined}
            disabled={item.disabled}
            pane={input.pane}
            onToggle={() => state.toggleFolderCollapsed(item.folder)}
            {...(projectsTab ? { onNewThread: () => startThreadInFolder(item) } : {})}
            onAction={(action) => handleAction(item, action)}
          />
        );
      case "v2-folder-more":
        return (
          <ThreadTreeMoreRow
            hiddenCount={item.hiddenCount}
            expanded={item.expanded}
            pane={input.pane}
            onToggle={() => state.toggleFolderExpanded(item.folder)}
          />
        );
    }
  };

  const arrangementSheet = state.arrangingFolders ? (
    <FolderArrangementSheet
      folders={state.folderOrder}
      onMove={state.moveFolder}
      onClose={state.closeFolderArrangement}
    />
  ) : null;

  return {
    folderOrder: state.folderOrder,
    groupListItems,
    renderItem,
    arrangementSheet,
  } as const;
}

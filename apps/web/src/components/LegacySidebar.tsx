import { attachSidebarTree } from "../lib/sidebarTree";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { Spinner } from "~/components/ui/spinner";
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderPlusIcon,
  Globe2Icon,
  SearchIcon,
  SquarePenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  PrStatusTooltipContent,
  ThreadTerminalStatusButton,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import React, {
  createContext,
  useEffect,
  useEffectEvent,
  memo,
  useContext,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  DragOverlay,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { isElectron } from "../env";
import { useStableCallback } from "../hooks/useStableCallback";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  readThreadShell,
  readThreadShells,
  useProjects,
  useDelegatedUnderParent,
  useThreadShells,
} from "../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { useAtomCommand } from "../state/use-atom-command";
import {
  ORCHESTRATION_OPERATE_DENIED_MESSAGE,
  useOrchestrationCommand,
} from "../state/use-orchestration-command";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { ensureLocalApi, readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../state/desktopUpdate";

import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadConversationActions } from "../hooks/useThreadConversationActions";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { RelativeTime } from "./RelativeTime";
import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  LEGACY_SIDEBAR_TAB_KEY,
  LegacySidebarNeedsYou,
  LegacySidebarTabSchema,
  LegacySidebarTabs,
  LegacySidebarWorkersList,
  legacyThreadWorkerMenu,
  NewWorkerButton,
  type WorkerProjectIndex,
} from "./LegacySidebarWorkers";
import type { LegacySidebarTab } from "./legacySidebarWorkers.logic";
import {
  chooseFolderThreadProject,
  groupByFolder,
  moveFolder,
} from "@t3tools/client-runtime/thread-folders";
import { resolveGroupPanel } from "./legacySidebarFolders.logic";
import {
  folderOfThread,
  moveThreadsToFolder,
  readFolderOrder,
  rememberDraftFolder,
  setFolderExpanded,
  setFolderOrder,
  threadsInFolder,
  useFolderExpanded,
  useFolderOrder,
  useFolderSettingsLoaded,
  useFolderThreadShells,
  useFolderView,
} from "./legacySidebarFolders.store";
import {
  DefaultFolderMark,
  legacyFolderHeaderMenu,
  legacyThreadFolderMenu,
  makeFolderPerProject,
  NewFolderButton,
} from "./LegacySidebarFolders";
import { Kbd } from "./ui/kbd";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import {
  deleteSelectedThreadEntries,
  filterSidebarV2VisibleThreads,
  resolveAdjacentThreadId,
  isSidebarHiddenThread,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
  useThreadJumpHintsVisible,
  ThreadStatusPill,
} from "./Sidebar.logic";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  getSidebarThreadIdsToPrewarm,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  shouldClearThreadSelectionOnMouseDown,
} from "./LegacySidebar.logic";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import {
  LegacySnoozedSection,
  legacyBulkSnoozeMenu,
  legacyThreadSnoozeMenu,
  useProvideLegacySnoozeActions,
  useWithoutLegacySnoozed,
} from "./LegacySidebar.snooze";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarThreadSummary } from "../types";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { type SidebarRouteReveal, useActiveRowReveal } from "./sidebar/routeReveal";
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function clampSidebarThreadPreviewCount(value: number): SidebarThreadPreviewCount {
  return Math.min(
    MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    Math.max(MIN_SIDEBAR_THREAD_PREVIEW_COUNT, value),
  ) as SidebarThreadPreviewCount;
}

function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

interface SidebarThreadRowProps {
  navigationParent?: string | undefined;
  thread: SidebarThreadSummary;
  /** Shown muted after the title when a folder mixes projects. */
  projectName: string | null;
  orderedThreadKeys: readonly string[];
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}

function checkTaskPermission(environmentId: EnvironmentId): boolean {
  if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return true;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Action unavailable",
      description: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
    }),
  );
  return false;
}

// The active row reports itself, so a route change scrolls to it once it mounts.
const RevealActiveRowContext = createContext<(row: HTMLElement | null, threadKey: string) => void>(
  () => {},
);

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    projectName,
    orderedThreadKeys,
    isActive,
    openPullRequestsInRightPanel,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    onFileDropThreads,
    thread,
  } = props;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(thread.environmentId, AuthPreviewOperateScope);
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const revealActiveRow = useContext(RevealActiveRowContext);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(isActive);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const isMobile = useMediaQuery("max-md");
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isThreadRunning = !threadRuntimeCanArchive(thread.runtime);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const {
    setNodeRef: setDragNodeRef,
    listeners: dragListeners,
    isDragging,
  } = useDraggable({
    id: `thread:${threadKey}`,
    data: { kind: "thread", threadKey, title: thread.title } satisfies SidebarDragData,
    disabled: !canOperateThread || renamingThreadKey === threadKey,
  });
  // Hooks must precede this ref's plain uses for the compiler to cache it.
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  const isHighlighted = isActive || isSelected;
  const handleOpenDiscoveredPort = (event: React.MouseEvent<HTMLButtonElement>) => {
    const port = discoveredPorts[0];
    if (!port || !canOperatePreview) return;
    event.preventDefault();
    event.stopPropagation();
    navigateToThread(threadRef);
    void (async () => {
      const result = await openDiscoveredPort({ threadRef, port, openPreview });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open preview",
          description: error instanceof Error ? error.message : "The preview could not be opened.",
        }),
      );
    })();
  };
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  const isConfirmingArchive =
    canOperateThread && confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : canOperateThread && !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 max-sm:pr-6 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const clearConfirmingArchive = () => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  };
  const handleMouseLeave = () => {
    clearConfirmingArchive();
  };
  const handleBlurCapture = (event: React.FocusEvent<HTMLLIElement>) => {
    const currentTarget = event.currentTarget;
    requestAnimationFrame(() => {
      if (currentTarget.contains(document.activeElement)) {
        return;
      }
      clearConfirmingArchive();
    });
  };
  const handleRowRef = (node: HTMLDivElement | null) => {
    setDragNodeRef(node);
    if (isActive) revealActiveRow(node, threadKey);
  };
  const handleRowClick = (event: React.MouseEvent) => {
    handleThreadClick(event, threadRef, orderedThreadKeys);
  };
  const handleRowDoubleClick = (event: React.MouseEvent) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
    if (renamingThreadKey === threadKey) return;
    // Mobile navigation closes the sidebar on the first tap, so rename stays in the context menu.
    if (isMobile) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("button, a")) return;
    event.preventDefault();
    startThreadRename(threadKey, thread.title);
  };
  const handleRowKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "F2" &&
      renamingThreadKey !== threadKey &&
      readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
    ) {
      event.preventDefault();
      startThreadRename(threadKey, thread.title);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    navigateToThread(threadRef);
  };
  const handleRowContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const hasSelection = useThreadSelectionStore.getState().hasSelection();
    if (hasSelection && isSelected) {
      void (async () => {
        const result = await settlePromise(() =>
          handleMultiSelectContextMenu({
            x: event.clientX,
            y: event.clientY,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread action failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
      return;
    }

    if (hasSelection) {
      clearSelection();
    }
    void (async () => {
      const result = await settlePromise(() =>
        handleThreadContextMenu(threadRef, {
          x: event.clientX,
          y: event.clientY,
        }),
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const handlePrClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const url = prStatus?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const openedInRightPanel = openPrLink(
      event,
      url,
      openPullRequestsInRightPanel ? threadRef : undefined,
    );
    if (openedInRightPanel && openPullRequestsInRightPanel && !isActive) {
      navigateToThread(threadRef);
    }
  };
  const handleRenameInputRef = (element: HTMLInputElement | null) => {
    if (element && renamingInputRef.current !== element) {
      renamingInputRef.current = element;
      element.focus();
      element.select();
    }
  };
  const handleRenameInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRenamingTitle(event.target.value);
  };
  const handleRenameInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      renamingCommittedRef.current = true;
      void commitRename(threadRef, renamingTitle, thread.title);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renamingCommittedRef.current = true;
      cancelRename();
    }
  };
  const handleRenameInputBlur = () => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  };
  // Stop dblclick propagation so word selection cannot restart rename and discard edits.
  const handleRenameInputClick = (event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  };
  const handleConfirmArchiveRef = (element: HTMLButtonElement | null) => {
    if (element) {
      confirmArchiveButtonRefs.current.set(threadKey, element);
    } else {
      confirmArchiveButtonRefs.current.delete(threadKey);
    }
  };
  const stopPropagationOnPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const handleConfirmArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearConfirmingArchive();
    void attemptArchiveThread(threadRef);
  };
  const handleStartArchiveConfirmation = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!checkTaskPermission(thread.environmentId)) return;
    setConfirmingArchiveThreadKey(threadKey);
    requestAnimationFrame(() => {
      confirmArchiveButtonRefs.current.get(threadKey)?.focus();
    });
  };
  const handleArchiveImmediateClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void attemptArchiveThread(threadRef);
  };

  return (
    <SidebarMenuSubItem
      ref={rowRef}
      className="w-full"
      data-thread-item
      {...fileDropHandlers}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <div
        ref={handleRowRef}
        {...dragListeners}
        role="button"
        tabIndex={0}
        data-sidebar-row={threadKey}
        data-sidebar-parent={props.navigationParent}
        aria-current={isActive ? "page" : undefined}
        data-active={isActive}
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={`thread-row-${thread.id}`}
        className={cn(
          "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
          isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
            : isSelected
              ? "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active"
              : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          isFileDragOver && "ring-1 ring-inset ring-primary/70",
          isDragging && "opacity-50",
        )}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex w-3.5 shrink-0 items-center justify-center">
          {threadStatus && <ThreadStatusLabel status={threadStatus} compact />}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && pr && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={prStatus.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handlePrClick}
                  >
                    <ChangeRequestStatusIcon
                      state={pr.state}
                      isDraft={pr.isDraft}
                      className="size-3"
                    />
                  </a>
                }
              />
              <TooltipPopup side="top">
                <PrStatusTooltipContent status={prStatus} />
              </TooltipPopup>
            </Tooltip>
          )}
          {!pr && currentLinkedPr ? (
            <a
              href={currentLinkedPr.url}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handlePrClick}
              className="text-muted-foreground"
              aria-label={`PR #${currentLinkedPr.number}, status pending`}
            >
              <PullRequestGlyph.pullRequest className="size-3" />
            </a>
          ) : null}
          {canOperateThread && renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
              onDoubleClick={handleRenameInputClick}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top">
                {thread.title}
                {/* The project shows on hover only, so titles keep the row's width. */}
                {projectName ? (
                  <span className="text-secondary-label"> · {projectName}</span>
                ) : null}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {canOperatePreview && discoveredPorts.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                    className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={handleOpenDiscoveredPort}
                  />
                }
              >
                <Globe2Icon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                Open localhost:{discoveredPorts[0]?.port}
                {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
              </TooltipPopup>
            </Tooltip>
          )}
          <ThreadWorktreeIndicator thread={thread} />
          <ThreadTerminalStatusButton
            threadRef={threadRef}
            terminalIds={runningTerminalIds}
            onThreadActivate={navigateToThread}
          />
          <div className="flex min-w-12 justify-end max-sm:min-w-20">
            {isConfirmingArchive ? (
              <button
                ref={handleConfirmArchiveRef}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-md bg-destructive/12 px-2 text-3xs font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-destructive/40"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleConfirmArchiveClick}
              >
                Confirm
              </button>
            ) : canOperateThread && !isThreadRunning ? (
              appSettingsConfirmThreadArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleStartArchiveConfirmation}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleArchiveImmediateClick}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span className={threadMetaClassName}>
              <span className="inline-flex items-center gap-1">
                {jumpLabel ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          aria-label={jumpLabel}
                          className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
                        />
                      }
                    >
                      {jumpLabel}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{jumpLabel}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span
                    className={`text-3xs tabular-nums ${
                      isHighlighted ? "text-foreground" : "text-secondary-label"
                    }`}
                  >
                    <RelativeTime
                      compact
                      timestamp={thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt}
                    />
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </div>
    </SidebarMenuSubItem>
  );
});

/** A thread's project, for its row's suffix and its menu's path and settings link. */
interface SidebarThreadProject {
  readonly projectKey: string;
  readonly displayName: string;
  readonly workspaceRoot: string;
}

function threadProjectScopedKey(thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">) {
  return scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
}

interface SidebarFolderThreadListProps {
  groupKey: string;
  expanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedThreadKeys: readonly string[];
  renderedThreads: readonly SidebarThreadSummary[];
  emptyThreadLabel: string | null;
  projectIndex: ReadonlyMap<string, SidebarThreadProject>;
  showProjectNames: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  expandThreadListForGroup: (groupKey: string) => void;
  collapseThreadListForGroup: (groupKey: string) => void;
}

const SidebarFolderThreadList = memo(function SidebarFolderThreadList(
  props: SidebarFolderThreadListProps,
) {
  const {
    groupKey,
    expanded,
    hasOverflowingThreads,
    hiddenThreadStatus,
    orderedThreadKeys,
    renderedThreads,
    emptyThreadLabel,
    projectIndex,
    showProjectNames,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    threadJumpLabelByKey,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    onFileDropThreads,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    expandThreadListForGroup,
    collapseThreadListForGroup,
  } = props;
  const showMoreButtonRender = <button type="button" />;
  const showLessButtonRender = <button type="button" />;

  return (
    <SidebarMenuSub
      role="presentation"
      ref={attachThreadListAutoAnimateRef}
      className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden empty:hidden sm:mx-1"
    >
      {emptyThreadLabel !== null ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-8 w-full translate-x-0 items-center px-2 text-left text-xs text-sidebar-muted-foreground/75"
          >
            <span>{emptyThreadLabel}</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {renderedThreads.map((thread) => {
        const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return (
          <SidebarThreadRow
            key={threadKey}
            thread={thread}
            projectName={
              showProjectNames
                ? (projectIndex.get(threadProjectScopedKey(thread))?.displayName ?? null)
                : null
            }
            navigationParent={expanded ? groupKey : undefined}
            orderedThreadKeys={orderedThreadKeys}
            isActive={activeRouteThreadKey === threadKey}
            openPullRequestsInRightPanel={openPullRequestsInRightPanel}
            jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
            appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
            renamingThreadKey={renamingThreadKey}
            renamingTitle={renamingTitle}
            setRenamingTitle={setRenamingTitle}
            startThreadRename={startThreadRename}
            renamingInputRef={renamingInputRef}
            renamingCommittedRef={renamingCommittedRef}
            confirmingArchiveThreadKey={confirmingArchiveThreadKey}
            setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
            confirmArchiveButtonRefs={confirmArchiveButtonRefs}
            handleThreadClick={handleThreadClick}
            navigateToThread={navigateToThread}
            onFileDropThreads={onFileDropThreads}
            handleMultiSelectContextMenu={handleMultiSelectContextMenu}
            handleThreadContextMenu={handleThreadContextMenu}
            clearSelection={clearSelection}
            commitRename={commitRename}
            cancelRename={cancelRename}
            attemptArchiveThread={attemptArchiveThread}
            openPrLink={openPrLink}
          />
        );
      })}

      {expanded && hasOverflowingThreads && renderedThreads.length < orderedThreadKeys.length && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            role="button"
            tabIndex={0}
            data-sidebar-row={`${groupKey}:more`}
            data-sidebar-parent={groupKey}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              expandThreadListForGroup(groupKey);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
              <span>Show more</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
      {expanded && hasOverflowingThreads && renderedThreads.length === orderedThreadKeys.length && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showLessButtonRender}
            role="button"
            tabIndex={0}
            data-sidebar-row={`${groupKey}:less`}
            data-sidebar-parent={groupKey}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              collapseThreadListForGroup(groupKey);
            }}
          >
            <span>Show less</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
    </SidebarMenuSub>
  );
});

interface SidebarFolderItemProps {
  /** The folder's name; null is Unfiled, the threads in no folder. */
  folder: string | null;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  startThreadInFolder: (folder: string | null) => void;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForGroup: (groupKey: string) => void;
  collapseThreadListForGroup: (groupKey: string) => void;
  projectIndex: ReadonlyMap<string, SidebarThreadProject>;
  /** Unfiled offers a folder per project until the first folder exists. */
  onMakeFolderPerProject: (() => void) | null;
  dragInProgressRef: React.RefObject<boolean>;
  suppressFolderClickAfterDragRef: React.RefObject<boolean>;
  suppressFolderClickForContextMenuRef: React.RefObject<boolean>;
  dragHandleProps: SortableFolderHandleProps | null;
}

function resolveFolderThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | undefined>,
) {
  const lastVisitedAt = lastVisitedAtByThreadKey.get(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  return resolveThreadStatusPill({
    thread: {
      ...thread,
      ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
    },
  });
}

/** Sidebar key of a folder group; also its sortable id. Folder names never contain a newline. */
function folderGroupKey(folder: string | null): string {
  return folder === null ? UNFILED_GROUP_KEY : `folder:${folder}`;
}

const UNFILED_GROUP_KEY = "unfiled";

/** What a drag carries: a thread row, or a folder being reordered. */
type SidebarDragData =
  | { readonly kind: "thread"; readonly threadKey: string; readonly title: string }
  | { readonly kind: "folder"; readonly folder: string | null };

function readDragData(data: { current?: unknown } | undefined): SidebarDragData | null {
  const value = data?.current as Partial<SidebarDragData> | undefined;
  return value?.kind === "thread" || value?.kind === "folder" ? (value as SidebarDragData) : null;
}

// Separate hooks keep array caches independent of the route-dependent panel.
function useFolderThreads(folder: string | null) {
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const sidebarThreads = useFolderThreadShells(folder);
  const withoutSnoozed = useWithoutLegacySnoozed();
  const delegatedUnderParent = useDelegatedUnderParent();
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      sidebarThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const sidebarThreadByKey = new Map(
    sidebarThreads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  const lastVisitedAtByThreadKey = new Map(
    sidebarThreads.map((thread, index) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      resolveThreadLastVisitedAt(thread.lastVisitedAt, threadLastVisitedAts[index] ?? undefined),
    ]),
  );
  const visibleFolderThreads = sortThreads(
    withoutSnoozed(filterSidebarV2VisibleThreads(sidebarThreads, null, delegatedUnderParent)),
    threadSortOrder,
  );
  const folderStatus = resolveProjectStatusIndicator(
    visibleFolderThreads.map((thread) =>
      resolveFolderThreadStatus(thread, lastVisitedAtByThreadKey),
    ),
  );
  const orderedThreadKeys = visibleFolderThreads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const showProjectNames = new Set(visibleFolderThreads.map(threadProjectScopedKey)).size > 1;
  return {
    sidebarThreadByKey,
    lastVisitedAtByThreadKey,
    visibleFolderThreads,
    folderStatus,
    orderedThreadKeys,
    showProjectNames,
  };
}

function useFolderThreadPanel(input: {
  visibleFolderThreads: readonly SidebarThreadSummary[];
  orderedThreadKeys: readonly string[];
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | undefined>;
  activeRouteThreadKey: string | null;
  folderExpanded: boolean;
  isThreadListExpanded: boolean;
}) {
  const {
    visibleFolderThreads,
    orderedThreadKeys,
    lastVisitedAtByThreadKey,
    activeRouteThreadKey,
    folderExpanded,
    isThreadListExpanded,
  } = input;
  const sidebarThreadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const panel = resolveGroupPanel({
    keys: orderedThreadKeys,
    expanded: folderExpanded,
    showAll: isThreadListExpanded,
    previewCount: sidebarThreadPreviewCount,
    activeKey: activeRouteThreadKey,
  });
  const threadByKey = new Map(
    visibleFolderThreads.map((thread, index) => [orderedThreadKeys[index]!, thread] as const),
  );
  return {
    hasOverflowingThreads: panel.hasOverflow,
    hiddenThreadStatus: resolveProjectStatusIndicator(
      panel.hidden.flatMap((key) => {
        const thread = threadByKey.get(key);
        return thread ? [resolveFolderThreadStatus(thread, lastVisitedAtByThreadKey)] : [];
      }),
    ),
    renderedThreads: panel.rendered.flatMap((key) => {
      const thread = threadByKey.get(key);
      return thread ? [thread] : [];
    }),
  };
}

const SidebarFolderItem = memo(function SidebarFolderItem(props: SidebarFolderItemProps) {
  const {
    folder,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    startThreadInFolder,
    archiveThread,
    deleteThread,
    markThreadUnread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForGroup,
    collapseThreadListForGroup,
    projectIndex,
    onMakeFolderPerProject,
    dragInProgressRef,
    suppressFolderClickAfterDragRef,
    suppressFolderClickForContextMenuRef,
    dragHandleProps,
  } = props;
  const groupKey = folderGroupKey(folder);
  const folderLabel = folder ?? "Unfiled";
  const appSettingsConfirmThreadDelete = useClientSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useClientSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const router = useRouter();
  const { forkConversation, copyProviderSessionId } = useThreadConversationActions();
  const handleNewThread = useNewThreadHandler();
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const { isMobile, setOpenMobile } = useSidebar();
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const openPrLink = useOpenPrLink();
  const {
    sidebarThreadByKey,
    folderStatus,
    visibleFolderThreads,
    orderedThreadKeys,
    lastVisitedAtByThreadKey,
    showProjectNames,
  } = useFolderThreads(folder);
  const folderExpanded = useFolderExpanded(folder);
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const { hasOverflowingThreads, hiddenThreadStatus, renderedThreads } = useFolderThreadPanel({
    visibleFolderThreads,
    orderedThreadKeys,
    lastVisitedAtByThreadKey,
    activeRouteThreadKey,
    folderExpanded,
    isThreadListExpanded,
  });
  const emptyThreadLabel =
    folderExpanded && visibleFolderThreads.length === 0
      ? folder === null
        ? "No threads"
        : "Drag threads here"
      : null;

  const handleFolderButtonClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressFolderClickForContextMenuRef.current) {
      suppressFolderClickForContextMenuRef.current = false;
      // A keyboard-made click (detail 0) never follows a context menu.
      if (event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (dragInProgressRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (suppressFolderClickAfterDragRef.current) {
      suppressFolderClickAfterDragRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (useThreadSelectionStore.getState().hasSelection()) {
      clearSelection();
    }
    setFolderExpanded(folder, !folderExpanded);
  };

  const handleFolderButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (dragInProgressRef.current) {
      return;
    }
    setFolderExpanded(folder, !folderExpanded);
  };

  const handleFolderButtonPointerDownCapture = (event: React.PointerEvent<HTMLButtonElement>) => {
    suppressFolderClickForContextMenuRef.current = false;
    if (
      isContextMenuPointerDown({
        button: event.button,
        ctrlKey: event.ctrlKey,
        isMac: isMacPlatform(navigator.platform),
      })
    ) {
      event.stopPropagation();
    }

    suppressFolderClickAfterDragRef.current = false;
  };

  const showFolderMenu = async (name: string, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const menu = legacyFolderHeaderMenu(name);
    await menu.handle(await api.contextMenu.show(menu.items, position));
  };

  const handleFolderButtonContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (folder === null) return;
    suppressFolderClickForContextMenuRef.current = true;
    void showFolderMenu(folder, { x: event.clientX, y: event.clientY });
  };

  const handleFolderMenuButtonClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (folder === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    void showFolderMenu(folder, { x: rect.left, y: rect.bottom });
  };

  const handleCreateThreadClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    startThreadInFolder(folder);
  };

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };
  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const targetPathname = router.buildLocation({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    }).pathname;
    if (targetPathname === router.state.location.pathname) return;
    try {
      await navigateToThread(threadRef);
      if (targetPathname !== router.state.location.pathname) {
        clearPendingFileDrop(dropId);
      }
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const handleThreadClick = (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedThreadKeys: readonly string[],
  ) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const isShiftClick = event.shiftKey;
    const threadKey = scopedThreadKey(threadRef);
    const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadKey);
      return;
    }

    if (isShiftClick) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeys);
      return;
    }

    // Ignore trailing double-clicks after modifier handling so rename does not navigate or break selection.
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }

    if (currentSelectionCount > 0) {
      clearSelection();
    }
    setSelectionAnchor(threadKey);
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const handleMultiSelectContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
    if (threadKeys.length === 0) return;
    const count = threadKeys.length;
    const selectedThreadEntries = threadKeys.flatMap((threadKey) => {
      const threadRef = parseScopedThreadKey(threadKey);
      const thread = threadRef ? readThreadShell(threadRef) : null;
      return threadRef && thread ? [{ threadKey, threadRef, thread }] : [];
    });
    const hasRunningThread = selectedThreadEntries.some(
      ({ thread }) => !threadRuntimeCanArchive(thread.runtime),
    );
    const canOperateSelection = selectedThreadEntries.every(({ threadRef }) =>
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
    );

    const snoozeMenu = legacyBulkSnoozeMenu(selectedThreadEntries.map(({ thread }) => thread));
    const folderMenu = legacyThreadFolderMenu(selectedThreadEntries.map(({ thread }) => thread));
    const clicked = await api.contextMenu.show(
      [
        ...snoozeMenu.items,
        ...folderMenu.items,
        ...buildMultiSelectThreadContextMenuItems({ count, hasRunningThread }).map((item) =>
          item.id === "archive" || item.id === "delete"
            ? { ...item, disabled: item.disabled || !canOperateSelection }
            : item,
        ),
      ],
      position,
    );

    if (snoozeMenu.handle(clicked) || folderMenu.handle(clicked)) {
      clearSelection();
      return;
    }

    if (clicked === "mark-unread") {
      for (const { threadRef } of selectedThreadEntries) {
        markThreadUnread(threadRef);
      }
      clearSelection();
      return;
    }

    if (
      (clicked === "archive" || clicked === "delete") &&
      !selectedThreadEntries.every(({ threadRef }) => checkTaskPermission(threadRef.environmentId))
    ) {
      return;
    }

    if (clicked === "archive") {
      if (appSettingsConfirmThreadArchive) {
        const confirmed = await api.dialogs.confirm(
          `Archive ${count} thread${count === 1 ? "" : "s"}?`,
        );
        if (!confirmed) return;
      }
      if (
        !selectedThreadEntries.every(({ threadRef }) =>
          checkTaskPermission(threadRef.environmentId),
        )
      ) {
        return;
      }

      const archiveOutcome = await archiveSelectedThreadEntries({
        entries: selectedThreadEntries,
        archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
      });
      for (const failure of archiveOutcome.followupFailures) {
        if (isAtomCommandInterrupted(failure)) continue;
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread archived, but navigation failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      if (archiveOutcome.mutationFailure) {
        removeFromSelection(archiveOutcome.archivedThreadKeys);
        if (!isAtomCommandInterrupted(archiveOutcome.mutationFailure)) {
          const error = squashAtomCommandFailure(archiveOutcome.mutationFailure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to archive threads",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      removeFromSelection(threadKeys);
      return;
    }

    if (clicked !== "delete") return;

    if (appSettingsConfirmThreadDelete) {
      const confirmed = await api.dialogs.confirm(
        [
          `Delete ${count} thread${count === 1 ? "" : "s"}?`,
          "This permanently clears conversation history for these threads.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (!confirmed) return;
    }
    if (
      !selectedThreadEntries.every(({ threadRef }) => checkTaskPermission(threadRef.environmentId))
    ) {
      return;
    }

    const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
      entries: selectedThreadEntries,
      delete: ({ threadRef }, deletedThreadKeys) => deleteThread(threadRef, { deletedThreadKeys }),
    });
    if (firstFailure !== null) {
      const firstError = squashAtomCommandFailure(firstFailure);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to delete threads",
          description: firstError instanceof Error ? firstError.message : "An error occurred.",
        }),
      );
    }
    removeFromSelection(
      getThreadKeysToDeselectAfterDelete(threadKeys, deletedThreadKeys, (threadKey) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef !== null && readThreadShell(threadRef) !== null;
      }),
    );
  };

  const attemptArchiveThread = async (threadRef: ScopedThreadRef) => {
    if (!checkTaskPermission(threadRef.environmentId)) return;
    const result = await archiveThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const cancelRename = () => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  };

  const startThreadRename = (threadKey: string, title: string) => {
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef || !checkTaskPermission(threadRef.environmentId)) return;
    setRenamingThreadKey(threadKey);
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  };

  const commitRename = async (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    const finishRename = () => {
      setRenamingThreadKey((current) => {
        if (current !== threadKey) return current;
        renamingInputRef.current = null;
        return null;
      });
    };

    const trimmed = newTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      finishRename();
      return;
    }
    if (trimmed === originalTitle) {
      finishRename();
      return;
    }
    const result = await updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        title: trimmed,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    finishRename();
  };

  const handleThreadContextMenu = useStableCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKey.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject = projectIndex.get(threadProjectScopedKey(thread));
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.workspaceRoot ?? null;
      const canOperateThread = readEnvironmentScope(
        thread.environmentId,
        AuthOrchestrationOperateScope,
      );
      const snoozeMenu = legacyThreadSnoozeMenu(thread);
      const workerMenu = legacyThreadWorkerMenu(thread);
      const folderMenu = legacyThreadFolderMenu([thread]);
      const clicked = await api.contextMenu.show(
        [
          {
            id: "fork-conversation",
            label: "Fork conversation",
            icon: "git-fork",
            disabled: !canOperateThread,
          },
          ...(thread.branch
            ? [{ id: "new-thread-on-branch", label: `New thread on ${thread.branch}` }]
            : []),
          ...snoozeMenu.items,
          ...folderMenu.items,
          ...workerMenu.items,
          { id: "rename", label: "Rename thread", disabled: !canOperateThread },
          ...(appAtomRegistry.get(canShareWithGuestAtom(thread.environmentId))
            ? [{ id: "share-guest", label: "Share with guest" }]
            : []),
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread", label: "Copy Thread" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "copy-provider-session-id", label: "Copy provider session ID", icon: "hash" },
          { id: "project-settings", label: "Project settings", disabled: !threadProject },
          {
            id: "delete",
            label: "Delete",
            destructive: true,
            icon: "trash",
            disabled: !canOperateThread,
          },
        ],
        position,
      );

      if (snoozeMenu.handle(clicked)) return;
      if (folderMenu.handle(clicked)) return;
      if (workerMenu.handle(clicked)) return;
      if (clicked === "project-settings") {
        if (!threadProject) return;
        if (isMobile) setOpenMobile(false);
        void router.navigate({
          to: "/projects/$projectKey",
          params: { projectKey: threadProject.projectKey },
        });
        return;
      }

      if (clicked === "fork-conversation") {
        if (!checkTaskPermission(threadRef.environmentId)) return;
        if (await forkConversation(threadRef)) {
          if (isMobile) setOpenMobile(false);
        }
        return;
      }
      if (clicked === "copy-provider-session-id") {
        await copyProviderSessionId(threadRef);
        return;
      }

      if (clicked === "new-thread-on-branch") {
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            envMode: thread.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "rename") {
        startThreadRename(threadKey, thread.title);
        return;
      }

      if (clicked === "share-guest") {
        openGuestShareDialog(threadRef);
        return;
      }
      if (clicked === "mark-unread") {
        markThreadUnread(threadRef);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread") {
        void copyThreadReference(threadChipCopyTarget(threadRef, thread.title));
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked !== "delete") return;
      if (!checkTaskPermission(threadRef.environmentId)) return;
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) {
          return;
        }
      }
      if (!checkTaskPermission(threadRef.environmentId)) return;
      const result = await deleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
  );

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={dragHandleProps?.setActivatorNodeRef}
          className={dragHandleProps ? "cursor-grab active:cursor-grabbing" : undefined}
          {...(dragHandleProps ? dragHandleProps.attributes : {})}
          {...(dragHandleProps ? dragHandleProps.listeners : {})}
          role="button"
          tabIndex={0}
          data-sidebar-row={groupKey}
          data-testid={folder === null ? "sidebar-unfiled-header" : "sidebar-folder-header"}
          aria-expanded={folderExpanded}
          aria-label={folderLabel}
          onPointerDownCapture={handleFolderButtonPointerDownCapture}
          onClick={handleFolderButtonClick}
          onKeyDown={handleFolderButtonKeyDown}
          onContextMenu={handleFolderButtonContextMenu}
        >
          {!folderExpanded && folderStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={folderStatus.label}
                    className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${folderStatus.colorClass}`}
                  />
                }
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${folderStatus.dotClass} ${
                      folderStatus.pulse ? "motion-safe:animate-status-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </TooltipTrigger>
              <TooltipPopup side="top">{folderStatus.label}</TooltipPopup>
            </Tooltip>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                folderExpanded ? "rotate-90" : ""
              }`}
            />
          )}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                "truncate text-sm font-medium",
                folder === null ? "text-sidebar-muted-foreground" : "text-sidebar-foreground/90",
              )}
            >
              {folderLabel}
            </span>
            {folder !== null ? <DefaultFolderMark folder={folder} /> : null}
          </span>
          <span
            aria-hidden
            className={folder === null ? "w-4 shrink-0 max-sm:w-10" : "w-10 shrink-0 max-sm:w-16"}
          />
        </SidebarMenuButton>

        <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
          {folder !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Folder options for ${folder}`}
                    data-sidebar-action-for={groupKey}
                    data-testid="folder-menu-button"
                    className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleFolderMenuButtonClick}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Folder options</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Create new thread in ${folderLabel}`}
                  data-sidebar-action-for={groupKey}
                  data-testid="new-thread-button"
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={handleCreateThreadClick}
                />
              }
            >
              <SquarePenIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New thread in {folderLabel}</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {onMakeFolderPerProject && folderExpanded ? (
        <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 sm:mx-1">
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              data-testid="sidebar-folder-per-project"
              size="sm"
              onClick={onMakeFolderPerProject}
            >
              <FolderPlusIcon className="size-3.5" />
              <span>Make a folder for each project</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        </SidebarMenuSub>
      ) : null}

      <SidebarFolderThreadList
        groupKey={groupKey}
        expanded={folderExpanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadStatus={hiddenThreadStatus}
        orderedThreadKeys={orderedThreadKeys}
        renderedThreads={renderedThreads}
        emptyThreadLabel={emptyThreadLabel}
        projectIndex={projectIndex}
        showProjectNames={showProjectNames}
        activeRouteThreadKey={activeRouteThreadKey}
        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        startThreadRename={startThreadRename}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        onFileDropThreads={handleThreadFileDrop}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        expandThreadListForGroup={expandThreadListForGroup}
        collapseThreadListForGroup={collapseThreadListForGroup}
      />
    </>
  );
});

function LocalSecondaryStatus() {
  const { environments } = useEnvironments();
  // Poll desktop-local backends because the bridge has no change event.
  const secondaries = useDesktopLocalBootstraps();

  const localEnvByUrl = (() => {
    const map = new Map<string, { phase: string; error: string | null }>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  })();

  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const env =
      bootstrap.httpBaseUrl !== null ? localEnvByUrl.get(bootstrap.httpBaseUrl) : undefined;
    if (env?.phase === "connected") {
      continue;
    }
    if (env?.phase === "error") {
      failed.push({ label: bootstrap.label, error: env.error });
      continue;
    }
    connecting.push(bootstrap.label);
  }

  if (connecting.length === 0 && failed.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      {connecting.length > 0 ? (
        <Alert variant="sidebar">
          <Spinner />
          <AlertTitle>Connecting {connecting.join(", ")}</AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}

type SortableFolderHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function SidebarOptionsMenu({
  threadSortOrder,
  threadPreviewCount,
  onThreadSortOrderChange,
  onThreadPreviewCountChange,
}: {
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;
}) {
  const handleThreadPreviewCountChange = (nextValue: number | null) => {
    if (nextValue === null) {
      return;
    }

    const clampedValue = clampSidebarThreadPreviewCount(nextValue);
    if (clampedValue !== threadPreviewCount) {
      onThreadPreviewCountChange(clampedValue);
    }
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Sidebar options" />}
            />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sidebar options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">Sort threads</div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-muted-foreground sm:text-xs font-medium">
            Visible threads
          </div>
          <div className="px-2 py-1">
            <NumberField
              aria-label="Visible thread count"
              className="w-28"
              max={MAX_SIDEBAR_THREAD_PREVIEW_COUNT}
              min={MIN_SIDEBAR_THREAD_PREVIEW_COUNT}
              onValueChange={handleThreadPreviewCountChange}
              size="sm"
              step={1}
              value={threadPreviewCount}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement
                  aria-label="Decrease visible thread count"
                  className="[&_svg]:size-3.5"
                />
                <NumberFieldInput
                  aria-label="Visible thread count"
                  inputMode="numeric"
                  onKeyDownCapture={(event) => {
                    event.stopPropagation();
                  }}
                />
                <NumberFieldIncrement
                  aria-label="Increase visible thread count"
                  className="[&_svg]:size-3.5"
                />
              </NumberFieldGroup>
            </NumberField>
          </div>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableFolderItem({
  folder,
  children,
}: {
  folder: string;
  children: (handleProps: SortableFolderHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: folderGroupKey(folder),
    data: { kind: "folder", folder } satisfies SidebarDragData,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-inset ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

/** Unfiled never moves, but threads dropped on it leave their folder. */
function UnfiledDropTarget({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: UNFILED_GROUP_KEY,
    data: { kind: "folder", folder: null } satisfies SidebarDragData,
  });
  return (
    <li
      ref={setNodeRef}
      className={`group/menu-item relative rounded-md ${
        isOver ? "ring-1 ring-inset ring-primary/40" : ""
      }`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children}
    </li>
  );
}

/** The floating row under the pointer while threads are dragged to a folder. */
function ThreadDragPreview({ title, count }: { title: string; count: number }) {
  return (
    <div className="pointer-events-none flex h-8 max-w-64 items-center gap-2 rounded-md border bg-popover px-2 text-popover-foreground text-sm shadow-md">
      <span className="min-w-0 truncate">{title}</span>
      {count > 1 ? (
        <span className="shrink-0 text-3xs text-secondary-label">+{count - 1}</span>
      ) : null}
    </div>
  );
}

interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateActionPending: boolean;
  handleDesktopUpdateButtonClick: () => void;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  folderDnDSensors: ReturnType<typeof useSensors>;
  handleFolderDragStart: (event: DragStartEvent) => void;
  handleFolderDragEnd: (event: DragEndEvent) => void;
  handleFolderDragCancel: (event: DragCancelEvent) => void;
  draggingThreads: { readonly title: string; readonly count: number } | null;
  startThreadInFolder: (folder: string | null) => void;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  folderOrder: readonly string[];
  sidebarProjects: readonly SidebarProjectSnapshot[];
  projectIndex: ReadonlyMap<string, SidebarThreadProject>;
  expandedThreadListsByGroup: ReadonlySet<string>;
  activeRouteGroupKey: string | null;
  routeThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForGroup: (groupKey: string) => void;
  collapseThreadListForGroup: (groupKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressFolderClickAfterDragRef: React.RefObject<boolean>;
  suppressFolderClickForContextMenuRef: React.RefObject<boolean>;
  sidebarTab: LegacySidebarTab;
  onSidebarTabChange: (tab: LegacySidebarTab) => void;
  workerProjects: WorkerProjectIndex;
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateActionPending,
    handleDesktopUpdateButtonClick,
    threadSortOrder,
    threadPreviewCount,
    folderDnDSensors,
    handleFolderDragStart,
    handleFolderDragEnd,
    handleFolderDragCancel,
    draggingThreads,
    startThreadInFolder,
    archiveThread,
    deleteThread,
    markThreadUnread,
    folderOrder,
    sidebarProjects,
    projectIndex,
    expandedThreadListsByGroup,
    activeRouteGroupKey,
    routeThreadKey,
    openPullRequestsInRightPanel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForGroup,
    collapseThreadListForGroup,
    dragInProgressRef,
    suppressFolderClickAfterDragRef,
    suppressFolderClickForContextMenuRef,
    sidebarTab,
    onSidebarTabChange,
    workerProjects,
  } = props;

  const handleThreadSortOrderChange = (sortOrder: SidebarThreadSortOrder) => {
    updateClientSettings({ sidebarThreadSortOrder: sortOrder });
  };
  const handleThreadPreviewCountChange = (count: SidebarThreadPreviewCount) => {
    updateClientSettings({ sidebarThreadPreviewCount: count });
  };
  const folderSettingsLoaded = useFolderSettingsLoaded();
  const handleMakeFolderPerProject = () => {
    void makeFolderPerProject(sidebarProjects);
  };
  const renderFolderItem = (
    folder: string | null,
    dragHandleProps: SortableFolderHandleProps | null,
  ) => {
    const groupKey = folderGroupKey(folder);
    return (
      <SidebarFolderItem
        folder={folder}
        isThreadListExpanded={expandedThreadListsByGroup.has(groupKey)}
        activeRouteThreadKey={activeRouteGroupKey === groupKey ? routeThreadKey : null}
        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
        startThreadInFolder={startThreadInFolder}
        archiveThread={archiveThread}
        deleteThread={deleteThread}
        markThreadUnread={markThreadUnread}
        threadJumpLabelByKey={threadJumpLabelByKey}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        expandThreadListForGroup={expandThreadListForGroup}
        collapseThreadListForGroup={collapseThreadListForGroup}
        projectIndex={projectIndex}
        onMakeFolderPerProject={
          folder === null &&
          folderSettingsLoaded &&
          folderOrder.length === 0 &&
          sidebarProjects.length > 0
            ? handleMakeFolderPerProject
            : null
        }
        dragInProgressRef={dragInProgressRef}
        suppressFolderClickAfterDragRef={suppressFolderClickAfterDragRef}
        suppressFolderClickForContextMenuRef={suppressFolderClickForContextMenuRef}
        dragHandleProps={dragHandleProps}
      />
    );
  };

  return (
    <SidebarContent
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <SidebarMenu>
            <SidebarMenuItem>
              <CommandDialogTrigger
                render={<SidebarMenuButton data-testid="command-palette-trigger" />}
              >
                <SearchIcon />
                <span className="flex-1 truncate">Search</span>
                {commandPaletteShortcutLabel ? <Kbd>{commandPaletteShortcutLabel}</Kbd> : null}
              </CommandDialogTrigger>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      }
    >
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled || desktopUpdateActionPending}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      <LocalSecondaryStatus />
      <SidebarGroup>
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <LegacySidebarTabs value={sidebarTab} onChange={onSidebarTabChange} />
          {sidebarTab === "workers" ? (
            <NewWorkerButton />
          ) : (
            <div className="flex items-center gap-1">
              <SidebarOptionsMenu
                threadSortOrder={threadSortOrder}
                threadPreviewCount={threadPreviewCount}
                onThreadSortOrderChange={handleThreadSortOrderChange}
                onThreadPreviewCountChange={handleThreadPreviewCountChange}
              />
              <NewFolderButton />
            </div>
          )}
        </div>

        {sidebarTab === "workers" ? (
          <LegacySidebarWorkersList projects={workerProjects} routeThreadKey={routeThreadKey} />
        ) : (
          <>
            <LegacySidebarNeedsYou projects={workerProjects} routeThreadKey={routeThreadKey} />
            <DndContext
              sensors={folderDnDSensors}
              collisionDetection={folderCollisionDetection}
              modifiers={FOLDER_DND_MODIFIERS}
              onDragStart={handleFolderDragStart}
              onDragEnd={handleFolderDragEnd}
              onDragCancel={handleFolderDragCancel}
            >
              <SidebarMenu role="presentation" ref={attachSidebarTree}>
                <SortableContext
                  items={folderOrder.map(folderGroupKey)}
                  strategy={verticalListSortingStrategy}
                >
                  {folderOrder.map((folder) => (
                    <SortableFolderItem key={folder} folder={folder}>
                      {(dragHandleProps) => renderFolderItem(folder, dragHandleProps)}
                    </SortableFolderItem>
                  ))}
                </SortableContext>
                <UnfiledDropTarget>{renderFolderItem(null, null)}</UnfiledDropTarget>
              </SidebarMenu>
              {/* Mounted only for thread drags: with an overlay, sortable folders stop following the pointer. */}
              {draggingThreads
                ? createPortal(
                    <DragOverlay dropAnimation={null}>
                      <ThreadDragPreview
                        title={draggingThreads.title}
                        count={draggingThreads.count}
                      />
                    </DragOverlay>,
                    document.body,
                  )
                : null}
            </DndContext>
          </>
        )}
      </SidebarGroup>
      <LegacySnoozedSection projects={sidebarProjects} routeThreadKey={routeThreadKey} />
    </SidebarContent>
  );
});

const FOLDER_POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const FOLDER_DND_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

// A thread lands only on the folder under the pointer; a folder sorts among folders only.
const folderCollisionDetection: CollisionDetection = (args) => {
  if (readDragData(args.active.data)?.kind === "thread") {
    return pointerWithin(args);
  }
  const folderArgs = {
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => {
      const data = readDragData(container.data);
      return data?.kind === "folder" && data.folder !== null;
    }),
  };
  const pointerCollisions = pointerWithin(folderArgs);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  return closestCorners(folderArgs);
};

// Separate hooks cache real inputs; later sidebar hooks would invalidate every row's props.
function useLegacySidebarProjects() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const desktopLocalEnvironmentIds = new Set(
    environments
      .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  const wslEnvironmentIds = new Set(
    environments
      .filter(
        (environment) =>
          desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true,
      )
      .map((environment) => environment.environmentId),
  );
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const sidebarProjects: SidebarProjectSnapshot[] = buildSidebarProjectSnapshots({
    projects: orderedProjects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
    isWslEnvironment: (environmentId) => wslEnvironmentIds.has(environmentId),
  });
  const projectIndex = new Map<string, SidebarThreadProject>(
    sidebarProjects.flatMap((project) =>
      project.memberProjects.map(
        (member) =>
          [
            scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
            {
              projectKey: project.projectKey,
              displayName: project.displayName,
              workspaceRoot: member.workspaceRoot,
            },
          ] as const,
      ),
    ),
  );
  return {
    orderedProjects,
    sidebarProjects,
    projectIndex,
  };
}

function useLegacySidebarThreads(input: {
  folderOrder: readonly string[];
  routeThreadKey: string | null;
  sidebarThreadSortOrder: SidebarThreadSortOrder;
  sidebarThreadPreviewCount: number;
  expandedThreadListsByGroup: ReadonlySet<string>;
}) {
  const {
    folderOrder,
    routeThreadKey,
    sidebarThreadSortOrder,
    sidebarThreadPreviewCount,
    expandedThreadListsByGroup,
  } = input;
  const sidebarThreads = useThreadShells();
  const withoutSnoozed = useWithoutLegacySnoozed();
  const delegatedUnderParent = useDelegatedUnderParent();
  const { collapsed: collapsedFolders, unfiledCollapsed } = useFolderView();
  const sidebarThreadByKey = new Map(
    sidebarThreads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  const activeRouteThread = routeThreadKey ? sidebarThreadByKey.get(routeThreadKey) : undefined;
  const activeRouteGroupKey = activeRouteThread
    ? folderGroupKey(folderOfThread(activeRouteThread))
    : null;
  const listedThreads = sortThreads(
    withoutSnoozed(filterSidebarV2VisibleThreads(sidebarThreads, null, delegatedUnderParent)),
    sidebarThreadSortOrder,
  );
  const grouped = groupByFolder(listedThreads, folderOfThread, folderOrder);
  // The same panel rule the folders render with, so traversal and jump keys follow the screen.
  const visibleSidebarThreadKeys = [
    ...grouped.folders,
    { folder: null, threads: grouped.unfiled },
  ].flatMap(
    ({ folder, threads }) =>
      resolveGroupPanel({
        keys: threads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
        expanded: folder === null ? !unfiledCollapsed : !collapsedFolders.has(folder),
        showAll: expandedThreadListsByGroup.has(folderGroupKey(folder)),
        previewCount: sidebarThreadPreviewCount,
        activeKey: routeThreadKey,
      }).rendered,
  );
  const threadJumpCommandByKey = new Map<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >();
  for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
    const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
    if (!jumpCommand) {
      break;
    }
    threadJumpCommandByKey.set(threadKey, jumpCommand);
  }
  const prewarmedSidebarThreadRefs = getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys).flatMap(
    (threadKey) => {
      const ref = parseScopedThreadKey(threadKey);
      return ref ? [ref] : [];
    },
  );
  return {
    sidebarThreadByKey,
    activeRouteGroupKey,
    visibleSidebarThreadKeys,
    threadJumpCommandByKey,
    threadJumpThreadKeys: [...threadJumpCommandByKey.keys()],
    prewarmedSidebarThreadRefs,
  };
}

function clearThreadSelectionOnOutsideMouseDown(event: globalThis.MouseEvent) {
  const selection = useThreadSelectionStore.getState();
  if (!selection.hasSelection()) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (shouldClearThreadSelectionOnMouseDown(target)) selection.clearSelection();
}

export default function LegacySidebar({ routeReveal }: { routeReveal: SidebarRouteReveal }) {
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const handleNewThread = useNewThreadHandler();
  const { archiveThread, deleteThread, markThreadUnread, snoozeThread, unsnoozeThread } =
    useThreadActions();
  useProvideLegacySnoozeActions({ snoozeThread, unsnoozeThread });
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [sidebarTab, setSidebarTab] = useLocalStorage(
    LEGACY_SIDEBAR_TAB_KEY,
    "projects",
    LegacySidebarTabSchema,
  );
  const [expandedThreadListsByGroup, setExpandedThreadListsByGroup] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [draggingThreads, setDraggingThreads] = useState<{
    readonly threadKeys: readonly string[];
    readonly title: string;
    readonly count: number;
  } | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressFolderClickAfterDragRef = useRef(false);
  const suppressFolderClickForContextMenuRef = useRef(false);
  const desktopUpdateState = useDesktopUpdateState();
  const [desktopUpdateActionPending, setDesktopUpdateActionPending] = useState(false);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const { orderedProjects, sidebarProjects, projectIndex } = useLegacySidebarProjects();
  const folderOrder = useFolderOrder();
  const workerProjects: WorkerProjectIndex = {
    byScopedKey: projectIndex,
    order: sidebarProjects.map((project) => project.projectKey),
  };
  const {
    sidebarThreadByKey,
    activeRouteGroupKey,
    visibleSidebarThreadKeys,
    threadJumpCommandByKey,
    threadJumpThreadKeys,
    prewarmedSidebarThreadRefs,
  } = useLegacySidebarThreads({
    folderOrder,
    routeThreadKey,
    sidebarThreadSortOrder,
    sidebarThreadPreviewCount,
    expandedThreadListsByGroup,
  });
  const revealActiveRow = useActiveRowReveal(routeReveal, routeThreadKey);
  const shortcutLabelOptions = {
    platform,
    context: {
      terminalFocus: false,
      terminalOpen: false,
    },
  };

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  // A folder's new thread runs where its latest thread runs; the folder is only a label.
  const startThreadInFolder = useStableCallback((folder: string | null) => {
    const liveProjects = orderedProjects.filter((project) => project.archivedAt == null);
    const liveProjectKeys = new Set(
      liveProjects.map((project) =>
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      ),
    );
    const folderThreads = (folder === null ? readThreadShells() : threadsInFolder(folder))
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          !isSidebarHiddenThread(thread) &&
          folderOfThread(thread) === folder &&
          liveProjectKeys.has(threadProjectScopedKey(thread)),
      )
      .map((thread) => ({
        project: scopeProjectRef(thread.environmentId, thread.projectId),
        activeAt: thread.latestUserMessageAt ?? thread.updatedAt,
      }));
    const routeShell = routeThreadRef ? readThreadShell(routeThreadRef) : null;
    const routeProject = routeShell ?? routeDraftThread;
    const firstProject = liveProjects[0];
    const projectRef = chooseFolderThreadProject({
      folderThreads,
      current:
        routeProject && liveProjectKeys.has(threadProjectScopedKey(routeProject))
          ? scopeProjectRef(routeProject.environmentId, routeProject.projectId)
          : null,
      first: firstProject ? scopeProjectRef(firstProject.environmentId, firstProject.id) : null,
    });
    if (!projectRef) {
      openCommandPalette({ open: "add-project" });
      return;
    }
    if (isMobile) setOpenMobile(false);
    void (async () => {
      const result = await settlePromise(() => handleNewThread(projectRef));
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      if (result.value !== null) {
        rememberDraftFolder(
          result.value.draftId,
          scopeThreadRef(projectRef.environmentId, result.value.threadId),
          folder,
        );
      }
    })();
  });

  const folderDnDSensors = useSensors(useSensor(PointerSensor, FOLDER_POINTER_SENSOR_OPTIONS));

  const handleFolderDragStart = useStableCallback((event: DragStartEvent) => {
    const data = readDragData(event.active.data);
    if (data?.kind === "thread") {
      // Dragging a selected row carries the whole selection.
      const selected = useThreadSelectionStore.getState().selectedThreadKeys;
      const threadKeys = selected.has(data.threadKey) ? [...selected] : [data.threadKey];
      setDraggingThreads({ threadKeys, title: data.title, count: threadKeys.length });
      return;
    }
    dragInProgressRef.current = true;
    suppressFolderClickAfterDragRef.current = true;
  });

  const handleFolderDragEnd = useStableCallback((event: DragEndEvent) => {
    dragInProgressRef.current = false;
    const dragged = draggingThreads;
    setDraggingThreads(null);
    const activeData = readDragData(event.active.data);
    const overData = event.over ? readDragData(event.over.data) : null;
    if (overData?.kind !== "folder") return;
    if (activeData?.kind === "thread") {
      const threads = (dragged?.threadKeys ?? [activeData.threadKey]).flatMap((threadKey) => {
        const threadRef = parseScopedThreadKey(threadKey);
        const thread = threadRef ? readThreadShell(threadRef) : null;
        return thread ? [thread] : [];
      });
      if (threads.length > 1) clearSelection();
      void moveThreadsToFolder(threads, overData.folder);
      return;
    }
    if (activeData?.kind !== "folder" || activeData.folder === null || overData.folder === null) {
      return;
    }
    setFolderOrder(moveFolder(readFolderOrder(), activeData.folder, overData.folder));
  });

  const handleFolderDragCancel = (_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
    setDraggingThreads(null);
  };

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = (node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  };

  // Build before modifier-dependent context to give the compiler a separate cache used by every row.
  const threadJumpLabelByKey = buildThreadJumpLabelMap({
    keybindings,
    platform,
    terminalOpen: routeTerminalOpen,
    threadJumpCommandByKey,
  });
  // Upstream's hook reads the modifier keys and terminal focus itself, so holding the jump
  // modifier doesn't re-render the whole sidebar.
  const showThreadJumpHints = useThreadJumpHintsVisible(keybindings, routeThreadRef);
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;

  const onWindowKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const shortcutContext = {
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
    };

    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform,
      context: shortcutContext,
    });
    const traversalDirection = threadTraversalDirectionFromCommand(command);
    if (traversalDirection !== null) {
      const targetThreadKey = resolveAdjacentThreadId({
        threadIds: orderedSidebarThreadKeys,
        currentThreadId: routeThreadKey,
        direction: traversalDirection,
      });
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
      return;
    }

    const jumpIndex = threadJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) {
      return;
    }

    const targetThreadKey = threadJumpThreadKeys[jumpIndex];
    if (!targetThreadKey) {
      return;
    }
    const targetThread = sidebarThreadByKey.get(targetThreadKey);
    if (!targetThread) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for thread navigation shortcuts for the sidebar's lifetime
  useEffect(() => {
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => onWindowKeyDown(event);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);
  // A window listener whose lifetime is the sidebar's: no element owns outside clicks.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window mousedown listener that clears thread selection on outside clicks for the sidebar's lifetime
  useEffect(() => {
    window.addEventListener("mousedown", clearThreadSelectionOnOutsideMouseDown);
    return () => window.removeEventListener("mousedown", clearThreadSelectionOnOutsideMouseDown);
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const commandPaletteShortcutLabel = isMobile
    ? null
    : shortcutLabelForCommand(keybindings, "commandPalette.toggle", shortcutLabelOptions);
  const handleDesktopUpdateButtonClick = async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (
      desktopUpdateButtonDisabled ||
      desktopUpdateButtonAction === "none" ||
      desktopUpdateActionPending
    ) {
      return;
    }

    setDesktopUpdateActionPending(true);

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setDesktopUpdateActionPending(false));
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
        );
      } catch (error) {
        setDesktopUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setDesktopUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setDesktopUpdateActionPending(false));
    }
  };

  const expandThreadListForGroup = (groupKey: string) => {
    setExpandedThreadListsByGroup((current) => {
      if (current.has(groupKey)) return current;
      const next = new Set(current);
      next.add(groupKey);
      return next;
    });
  };

  const collapseThreadListForGroup = (groupKey: string) => {
    setExpandedThreadListsByGroup((current) => {
      if (!current.has(groupKey)) return current;
      const next = new Set(current);
      next.delete(groupKey);
      return next;
    });
  };

  return (
    <RevealActiveRowContext value={revealActiveRow}>
      {prewarmedSidebarThreadRefs.map((threadRef) => (
        <SidebarThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      <SidebarChromeHeader isElectron={isElectron} />

      <SidebarProjectsContent
        showArm64IntelBuildWarning={showArm64IntelBuildWarning}
        arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
        desktopUpdateButtonAction={desktopUpdateButtonAction}
        desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
        desktopUpdateActionPending={desktopUpdateActionPending}
        handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
        threadSortOrder={sidebarThreadSortOrder}
        threadPreviewCount={sidebarThreadPreviewCount}
        folderDnDSensors={folderDnDSensors}
        handleFolderDragStart={handleFolderDragStart}
        handleFolderDragEnd={handleFolderDragEnd}
        handleFolderDragCancel={handleFolderDragCancel}
        draggingThreads={draggingThreads}
        startThreadInFolder={startThreadInFolder}
        archiveThread={archiveThread}
        deleteThread={deleteThread}
        markThreadUnread={markThreadUnread}
        folderOrder={folderOrder}
        sidebarProjects={sidebarProjects}
        projectIndex={projectIndex}
        expandedThreadListsByGroup={expandedThreadListsByGroup}
        activeRouteGroupKey={activeRouteGroupKey}
        routeThreadKey={routeThreadKey}
        openPullRequestsInRightPanel={routeThreadRef !== null}
        commandPaletteShortcutLabel={commandPaletteShortcutLabel}
        threadJumpLabelByKey={visibleThreadJumpLabelByKey}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        expandThreadListForGroup={expandThreadListForGroup}
        collapseThreadListForGroup={collapseThreadListForGroup}
        dragInProgressRef={dragInProgressRef}
        suppressFolderClickAfterDragRef={suppressFolderClickAfterDragRef}
        suppressFolderClickForContextMenuRef={suppressFolderClickForContextMenuRef}
        sidebarTab={sidebarTab}
        onSidebarTabChange={setSidebarTab}
        workerProjects={workerProjects}
      />
      <SidebarChromeFooter />
    </RevealActiveRowContext>
  );
}

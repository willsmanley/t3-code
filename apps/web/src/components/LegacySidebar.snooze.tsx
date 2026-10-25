import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  canSnooze,
  effectiveSnoozed,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type MouseEvent, useEffect } from "react";
import { create } from "zustand";

import { getClientSettings } from "~/hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import type { useThreadActions } from "../hooks/useThreadActions";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsSnooze,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import {
  buildLegacyBulkSnoozeMenuItems,
  buildLegacySnoozeMenuItems,
  isLegacySnoozeMenuId,
  partitionLegacySnoozedThreads,
} from "./LegacySidebar.snooze.logic";
import { resolveSnoozePresets } from "./Sidebar.snooze";
import {
  filterSidebarV2VisibleThreads,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
} from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { SidebarGroup, SidebarMenuSub, SidebarMenuSubItem, useSidebar } from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { cn } from "~/lib/utils";

// Shared with the main sidebar, so switching sidebars keeps the shelf open or closed.
const SNOOZED_SECTION_EXPANDED_KEY = "t3code:sidebar:snoozed-expanded";

// The project trees classify snoozes against this clock instead of a minute
// tick, so they only re-render when the Snoozed section's timer says a thread
// is due. A stale value only errs toward "still snoozed", and the timer for
// the soonest wake fires at once when that wake has already passed.
const useLegacySnoozeClock = create<{ readonly now: string }>(() => ({
  now: new Date().toISOString(),
}));

function advanceLegacySnoozeClock() {
  useLegacySnoozeClock.setState({ now: new Date().toISOString() });
}

// setTimeout delays are signed 32-bit, so a wake more than ~24.8 days out
// waits in steps instead of overflowing and firing at once.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function scheduleSnoozeWake(wakeAt: string | null, onWake: () => void): (() => void) | undefined {
  const wakeAtMs = wakeAt === null ? Number.NaN : Date.parse(wakeAt);
  if (Number.isNaN(wakeAtMs)) return undefined;
  let id = 0;
  const arm = () => {
    const delayMs = Math.max(0, wakeAtMs - Date.now()) + 50;
    id =
      delayMs > MAX_TIMER_DELAY_MS
        ? window.setTimeout(arm, MAX_TIMER_DELAY_MS)
        : window.setTimeout(onWake, delayMs);
  };
  arm();
  return () => window.clearTimeout(id);
}

function useLegacySnoozePartition() {
  const now = useLegacySnoozeClock((state) => state.now);
  const serverConfigs = useServerConfigs();
  return <T extends EnvironmentThreadShell>(threads: readonly T[]) =>
    partitionLegacySnoozedThreads(threads, {
      now,
      supportsSnooze: (environmentId: EnvironmentId) =>
        serverConfigs.get(environmentId)?.environment.capabilities.threadSnooze === true,
    });
}

/** Removes snoozed threads from a project tree until they wake. */
export function useWithoutLegacySnoozed() {
  const partition = useLegacySnoozePartition();
  return <T extends EnvironmentThreadShell>(threads: readonly T[]): T[] => partition(threads).awake;
}

type LegacySnoozeActions = Pick<
  ReturnType<typeof useThreadActions>,
  "snoozeThread" | "unsnoozeThread"
>;

// The project rows open their menus deep below the sidebar root, which owns
// the single useThreadActions instance; menus read these at click time.
let legacySnoozeActions: LegacySnoozeActions | null = null;

export function useProvideLegacySnoozeActions(actions: LegacySnoozeActions) {
  const { snoozeThread, unsnoozeThread } = actions;
  useEffect(() => {
    const provided = { snoozeThread, unsnoozeThread };
    legacySnoozeActions = provided;
    return () => {
      if (legacySnoozeActions === provided) legacySnoozeActions = null;
    };
  }, [snoozeThread, unsnoozeThread]);
}

function reportFailures(
  results: ReadonlyArray<AtomCommandResult<unknown, unknown>>,
  title: { readonly one: string; readonly some: (count: number) => string },
) {
  const failures = results.flatMap((result) =>
    result._tag === "Failure" && !isAtomCommandInterrupted(result)
      ? [squashAtomCommandFailure(result)]
      : [],
  );
  if (failures.length === 0) return;
  const firstError = failures[0];
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: results.length === 1 ? title.one : title.some(failures.length),
      description: firstError instanceof Error ? firstError.message : "An error occurred.",
    }),
  );
}

async function snoozeThreads(threadRefs: readonly ScopedThreadRef[], snoozedUntil: string) {
  const actions = legacySnoozeActions;
  if (!actions) return;
  reportFailures(
    await Promise.all(threadRefs.map((ref) => actions.snoozeThread(ref, snoozedUntil))),
    {
      one: "Failed to snooze thread",
      some: (count) => `Failed to snooze ${count} thread${count === 1 ? "" : "s"}`,
    },
  );
}

async function wakeThread(threadRef: ScopedThreadRef) {
  const actions = legacySnoozeActions;
  if (!actions) return;
  reportFailures([await actions.unsnoozeThread(threadRef)], {
    one: "Failed to wake thread",
    some: () => "Failed to wake thread",
  });
}

async function runSnoozeChoice(
  clicked: string,
  snoozePresets: ReadonlyArray<SnoozePreset>,
  threadRefs: readonly ScopedThreadRef[],
) {
  const preset =
    clicked === "snooze:custom"
      ? await requestCustomSnooze()
      : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked);
  if (preset) await snoozeThreads(threadRefs, preset.snoozedUntil);
}

function currentSnoozePresets() {
  return resolveSnoozePresets(new Date(), getClientSettings().timestampFormat);
}

/** Snooze or Wake for one thread's context menu; `handle` returns whether it took the click. */
export function legacyThreadSnoozeMenu(thread: EnvironmentThreadShell) {
  const now = new Date().toISOString();
  const snoozePresets = currentSnoozePresets();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const items = buildLegacySnoozeMenuItems({
    canOperate: readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    supportsSnooze: readEnvironmentSupportsSnooze(thread.environmentId),
    isSnoozed: effectiveSnoozed(thread, { now }),
    canSnoozeNow: canSnooze(thread, { now }),
    snoozePresets,
  });
  const handle = (clicked: string | null): boolean => {
    if (!isLegacySnoozeMenuId(clicked)) return false;
    if (clicked === "unsnooze") void wakeThread(threadRef);
    else if (clicked !== "snooze") void runSnoozeChoice(clicked, snoozePresets, [threadRef]);
    return true;
  };
  return { items, handle };
}

/** Snooze for the multi-select menu, shown when every selected thread can snooze now. */
export function legacyBulkSnoozeMenu(threads: readonly EnvironmentThreadShell[]) {
  const now = new Date().toISOString();
  const snoozePresets = currentSnoozePresets();
  const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
  const items = buildLegacyBulkSnoozeMenuItems({
    count: threads.length,
    canOperate: threads.every((thread) =>
      readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    ),
    canSnoozeSelection:
      threads.length > 0 &&
      threads.every(
        (thread) =>
          readEnvironmentSupportsSnooze(thread.environmentId) && canSnooze(thread, { now }),
      ),
    snoozePresets,
  });
  const handle = (clicked: string | null): boolean => {
    if (!isLegacySnoozeMenuId(clicked)) return false;
    if (clicked !== "snooze" && clicked !== "unsnooze") {
      void runSnoozeChoice(clicked, snoozePresets, threadRefs);
    }
    return true;
  };
  return { items, handle };
}

/**
 * Snoozed threads from every project, soonest wake first, below the project
 * trees. Collapsed, it still shows the open thread when that one is snoozed.
 */
export function LegacySnoozedSection(props: {
  projects: readonly SidebarProjectSnapshot[];
  routeThreadKey: string | null;
}) {
  const { projects, routeThreadKey } = props;
  const threads = useThreadShells();
  const partition = useLegacySnoozePartition();
  const { snoozed } = partition(filterSidebarV2VisibleThreads(threads, null));
  const [expanded, setExpanded] = useLocalStorage(
    SNOOZED_SECTION_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const nextWakeAt = snoozed[0]?.snoozedUntil ?? null;
  useEffect(() => scheduleSnoozeWake(nextWakeAt, advanceLegacySnoozeClock), [nextWakeAt]);
  if (snoozed.length === 0) return null;
  const projectNameByKey = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) => [`${ref.environmentId}:${ref.projectId}`, project.displayName] as const,
      ),
    ),
  );
  const rows = expanded
    ? snoozed
    : snoozed.filter(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
      );
  return (
    <SidebarGroup>
      <CollapsibleSectionHeader
        expanded={expanded}
        tone="info"
        onClick={() => setExpanded((value) => !value)}
        data-testid="sidebar-snoozed-shelf-toggle"
      >
        {expanded ? "Snoozed" : `Snoozed (${snoozed.length})`}
      </CollapsibleSectionHeader>
      {rows.length > 0 ? (
        <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden sm:mx-1">
          {rows.map((thread) => {
            const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
            return (
              <LegacySnoozedThreadRow
                key={threadKey}
                thread={thread}
                projectName={projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`)}
                isActive={threadKey === routeThreadKey}
              />
            );
          })}
        </SidebarMenuSub>
      ) : null}
    </SidebarGroup>
  );
}

function LegacySnoozedThreadRow(props: {
  thread: EnvironmentThreadShell;
  projectName: string | undefined;
  isActive: boolean;
}) {
  const { thread, projectName, isActive } = props;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const nowMinute = useNowMinute();
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  });
  const wakeLabel =
    thread.snoozedUntil == null ? null : snoozeWakeLabel(thread.snoozedUntil, { now: nowMinute });
  const openThread = () => {
    const selection = useThreadSelectionStore.getState();
    if (selection.selectedThreadKeys.size > 0) selection.clearSelection();
    selection.setAnchor(threadKey);
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const menu = legacyThreadSnoozeMenu(thread);
    void api.contextMenu
      .show(menu.items, { x: event.clientX, y: event.clientY })
      .then((clicked) => menu.handle(clicked));
  };
  return (
    <SidebarMenuSubItem className="w-full" data-thread-item>
      <div
        role="button"
        tabIndex={0}
        data-active={isActive}
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        className={cn(
          "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onClick={openThread}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openThread();
        }}
        onContextMenu={handleContextMenu}
      >
        <div className="flex w-3.5 shrink-0 items-center justify-center">
          {threadStatus && <ThreadStatusLabel status={threadStatus} compact />}
        </div>
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {projectName ? (
          <span className="max-w-[40%] shrink truncate text-3xs text-secondary-label">
            {projectName}
          </span>
        ) : null}
        {wakeLabel ? (
          <span className="shrink-0 text-3xs tabular-nums text-info-foreground">{wakeLabel}</span>
        ) : null}
      </div>
    </SidebarMenuSubItem>
  );
}

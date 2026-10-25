import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { AlarmClockPlusIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import type { SidebarThreadSummary } from "../types";
import { RelativeTime } from "./RelativeTime";
import {
  ScheduledRelativeLabel,
  ScheduledStoppedLabel,
  scheduleLabel,
} from "./settings/ScheduledTasksSettings";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import {
  groupWorkersByProject,
  type LegacySidebarTab,
  resolveWorkerState,
  type WorkerState,
} from "./legacySidebarWorkers.logic";
import { Button } from "./ui/button";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const LEGACY_SIDEBAR_TAB_KEY = "t3code:legacy-sidebar-tab:v1";
export const LegacySidebarTabSchema = Schema.Literals(["projects", "workers"]);

// A failed run the user marked done stays out of "Needs you" until the next run.
const DISMISSED_WORKER_RUNS_KEY = "t3code:worker-dismissed-runs:v1";
const DismissedWorkerRunsSchema = Schema.Record(Schema.String, Schema.String);
const NO_DISMISSED_RUNS: Record<string, string> = {};

const NEEDS_YOU_GROUP_KEY = "needs-you";

const TABS: ReadonlyArray<{ readonly id: LegacySidebarTab; readonly label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "workers", label: "Workers" },
];

export interface WorkerProjectIndex {
  /** Logical project (key and name) for each scoped physical project key. */
  readonly byScopedKey: ReadonlyMap<string, { projectKey: string; displayName: string }>;
  /** Logical project keys in sidebar order. */
  readonly order: readonly string[];
}

export function LegacySidebarTabs(props: {
  value: LegacySidebarTab;
  onChange: (tab: LegacySidebarTab) => void;
}) {
  return (
    <div role="tablist" className="flex items-center gap-3">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={props.value === tab.id}
          data-testid={`sidebar-tab-${tab.id}`}
          className={cn(
            "cursor-pointer text-xs font-medium outline-hidden transition-colors focus-visible:text-sidebar-foreground",
            props.value === tab.id
              ? "text-sidebar-foreground/90"
              : "text-sidebar-muted-foreground/60 hover:text-sidebar-foreground",
          )}
          onClick={() => props.onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function NewWorkerButton() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="New worker"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              void navigate({ to: "/settings/scheduled-tasks" });
            }}
          />
        }
      >
        <AlarmClockPlusIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="right">New worker</TooltipPopup>
    </Tooltip>
  );
}

interface WorkerEntry {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly thread: SidebarThreadSummary | null;
  readonly state: WorkerState;
}

interface LegacySidebarWorkersProps {
  readonly projects: WorkerProjectIndex;
  readonly routeThreadKey: string | null;
}

/** Projects tab: the workers whose latest run needs the user. */
export function LegacySidebarNeedsYou(props: LegacySidebarWorkersProps) {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <EnvironmentWorkers
      key={environmentId}
      environmentId={environmentId}
      mode="needs-you"
      {...props}
    />
  ));
}

/** Workers tab: every scheduled task, grouped by project. */
export function LegacySidebarWorkersList(props: LegacySidebarWorkersProps) {
  const environmentIds = useConnectedEnvironmentIds();
  if (environmentIds.length === 0) {
    return <div className="px-2 pt-4 text-center text-secondary-label text-xs">No workers yet</div>;
  }
  return environmentIds.map((environmentId) => (
    <EnvironmentWorkers key={environmentId} environmentId={environmentId} mode="all" {...props} />
  ));
}

function useConnectedEnvironmentIds(): EnvironmentId[] {
  const { environments } = useEnvironments();
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" && environment.serverConfig !== null,
    )
    .map((environment) => environment.environmentId);
}

function EnvironmentWorkers(
  props: LegacySidebarWorkersProps & {
    environmentId: EnvironmentId;
    mode: "needs-you" | "all";
  },
) {
  const { environmentId, mode, projects, routeThreadKey } = props;
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const threadShells = useThreadShells();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [dismissedRuns, setDismissedRuns] = useLocalStorage(
    DISMISSED_WORKER_RUNS_KEY,
    NO_DISMISSED_RUNS,
    DismissedWorkerRunsSchema,
  );
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const tasks = tasksQuery.data?.tasks;
  if (!tasks) return null;

  const shellByKey = new Map(
    threadShells.map((shell) => [
      scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)),
      shell,
    ]),
  );
  const workers: WorkerEntry[] = tasks.map((task) => {
    const threadKey = task.threadId
      ? scopedThreadKey(scopeThreadRef(environmentId, task.threadId))
      : null;
    const thread = threadKey ? (shellByKey.get(threadKey) ?? null) : null;
    const threadPill =
      thread && threadKey
        ? resolveThreadStatusPill({
            thread: {
              ...thread,
              lastVisitedAt: resolveThreadLastVisitedAt(
                thread.lastVisitedAt,
                localLastVisitedAtById[threadKey],
              ),
            },
          })
        : null;
    return {
      environmentId,
      task,
      thread,
      state: resolveWorkerState({
        task,
        threadPill,
        dismissedRunAt: dismissedRuns[task.id] ?? null,
      }),
    };
  });

  const dismiss = (task: ScheduledTask) => {
    if (task.lastRunAt === null) return;
    const runAt = task.lastRunAt;
    setDismissedRuns((current) => ({ ...current, [task.id]: runAt }));
  };
  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };
  const renderRows = (entries: readonly WorkerEntry[]) =>
    entries.map((worker) => (
      <SidebarWorkerRow
        key={worker.task.id}
        worker={worker}
        isActive={
          worker.task.threadId !== null &&
          routeThreadKey === scopedThreadKey(scopeThreadRef(environmentId, worker.task.threadId))
        }
        showLastRun={mode === "needs-you"}
        onDismiss={dismiss}
      />
    ));

  if (mode === "needs-you") {
    const needsYou = workers.filter((worker) => worker.state.needsYou);
    if (needsYou.length === 0) return null;
    return (
      <SidebarMenu className="mb-1">
        <WorkerGroup
          name="Needs you"
          expanded={!collapsedGroups.has(NEEDS_YOU_GROUP_KEY)}
          onToggle={() => toggleGroup(NEEDS_YOU_GROUP_KEY)}
        >
          {renderRows(needsYou)}
        </WorkerGroup>
      </SidebarMenu>
    );
  }

  if (workers.length === 0) {
    return <div className="px-2 pt-4 text-center text-secondary-label text-xs">No workers yet</div>;
  }
  const projectOf = (worker: WorkerEntry) =>
    projects.byScopedKey.get(
      scopedProjectKey(scopeProjectRef(worker.environmentId, worker.task.projectId)),
    );
  const groups = groupWorkersByProject(
    workers,
    (worker) => projectOf(worker)?.projectKey ?? `unknown:${worker.task.projectId}`,
    projects.order,
  );
  return (
    <SidebarMenu>
      {groups.map((group) => (
        <WorkerGroup
          key={group.projectKey}
          name={projectOf(group.workers[0]!)?.displayName ?? "Other"}
          expanded={!collapsedGroups.has(group.projectKey)}
          onToggle={() => toggleGroup(group.projectKey)}
        >
          {renderRows(group.workers)}
        </WorkerGroup>
      ))}
    </SidebarMenu>
  );
}

function WorkerGroup(props: {
  name: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={props.onToggle}>
        <ChevronRightIcon
          className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
            props.expanded ? "rotate-90" : ""
          }`}
        />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium text-sidebar-foreground/90">
            {props.name}
          </span>
        </span>
      </SidebarMenuButton>
      {props.expanded ? (
        <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden empty:hidden sm:mx-1">
          {props.children}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

function SidebarWorkerRow(props: {
  worker: WorkerEntry;
  isActive: boolean;
  showLastRun: boolean;
  onDismiss: (task: ScheduledTask) => void;
}) {
  const { worker, isActive, showLastRun, onDismiss } = props;
  const { environmentId, task, thread, state } = worker;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "worker enabled",
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "worker run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "worker delete",
  });

  const reportFailure = <A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update worker",
        description: String(squashAtomCommandFailure(result)),
      }),
    );
  };
  const openSettings = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId, taskId: task.id },
    });
  };
  // A worker's runs land in its thread, so that is where its history lives.
  const open = () => {
    if (task.threadId === null) {
      openSettings();
      return;
    }
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, task.threadId)),
    });
  };
  const handleContextMenu = async (event: React.MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
    const canDismiss = state.needsYou && task.lastRunStatus === "failed";
    const clicked = await api.contextMenu.show(
      [
        { id: "run-now", label: "Run now", disabled: !canOperate },
        task.enabled
          ? { id: "pause", label: "Pause", disabled: !canOperate }
          : { id: "resume", label: "Resume", disabled: !canOperate },
        ...(canDismiss ? [{ id: "dismiss", label: "Mark done" }] : []),
        { id: "edit", label: "Edit worker" },
        {
          id: "delete",
          label: "Delete worker",
          destructive: true,
          icon: "trash",
          disabled: !canOperate,
        },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "edit") return openSettings();
    if (clicked === "dismiss") return onDismiss(task);
    if (clicked === "run-now") {
      reportFailure(await runNow({ environmentId, input: { id: task.id } }));
      return;
    }
    if (clicked === "pause" || clicked === "resume") {
      reportFailure(
        await setEnabled({ environmentId, input: { id: task.id, enabled: clicked === "resume" } }),
      );
      return;
    }
    if (clicked !== "delete") return;
    const confirmed = await api.dialogs.confirm(
      [`Delete worker "${task.title}"?`, "Its thread and history stay where they are."].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    reportFailure(await remove({ environmentId, input: { id: task.id } }));
  };

  const meta = showLastRun ? (
    <RelativeTime compact timestamp={task.lastRunAt ?? thread?.updatedAt ?? task.updatedAt} />
  ) : !task.enabled ? (
    <ScheduledStoppedLabel task={task} />
  ) : task.schedule.type === "webhook" ? (
    "Webhook"
  ) : task.nextRunAt !== null ? (
    <ScheduledRelativeLabel value={task.nextRunAt} />
  ) : task.lastRunAt !== null ? (
    <RelativeTime compact timestamp={task.lastRunAt} />
  ) : null;

  return (
    <SidebarMenuSubItem className="w-full" data-thread-item>
      <div
        role="button"
        tabIndex={0}
        data-active={isActive}
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={`worker-row-${task.id}`}
        className={cn(
          "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        }}
        onContextMenu={(event) => void handleContextMenu(event)}
      >
        <div className="flex w-3.5 shrink-0 items-center justify-center">
          {state.pill && <ThreadStatusLabel status={state.pill} compact />}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>}
            />
            <TooltipPopup side="top">
              {scheduleLabel(task.schedule)}
              {task.lastRunError ? ` · ${task.lastRunError}` : ""}
            </TooltipPopup>
          </Tooltip>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="flex min-w-12 justify-end max-sm:min-w-20">
            <span
              className={`text-3xs tabular-nums ${isActive ? "text-foreground" : "text-secondary-label"}`}
            >
              {meta}
            </span>
          </div>
        </div>
      </div>
    </SidebarMenuSubItem>
  );
}

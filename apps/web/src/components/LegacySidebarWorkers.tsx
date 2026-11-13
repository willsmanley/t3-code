import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { AlarmClockPlusIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  isWorkerThread,
  type ProjectId,
  type ScheduledTask,
  type ScopedThreadRef,
  type ThreadId,
  WORKER_THREAD_TAG,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
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
import { useThreadActions } from "../hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import type { SidebarThreadSummary } from "../types";
import { RelativeTime } from "./RelativeTime";
import { ScheduledRelativeLabel, ScheduledStoppedLabel } from "./settings/ScheduledTasksSettings";
import { scheduleLabel } from "./settings/scheduledTasksSettings.logic";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import {
  groupWorkers,
  type LegacySidebarTab,
  resolveJobThreadState,
  resolveWorkerState,
  resolveWorkerThreadState,
  soonestRunAt,
  type WorkerState,
} from "./legacySidebarWorkers.logic";
import { legacyThreadFolderMenu } from "./LegacySidebarFolders";
import { folderOfThread, setFolderExpanded, useFolderView } from "./legacySidebarFolders.store";
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

// Workers whose threads are archived and that won't run again stay out of the list unless shown.
const SHOW_ARCHIVED_WORKERS_KEY = "t3code:workers-show-archived:v1";

const PROJECT_THREAD_JOBS_GROUP_KEY = "project-thread-jobs";
// Not a folder name: folder names are never empty.
const UNFILED_WORKERS_KEY = "";

function toastFailure(title: string, error: unknown) {
  toastManager.add(stackedThreadToast({ type: "error", title, description: String(error) }));
}

function reportCommandFailure<A, E>(title: string, result: AtomCommandResult<A, E>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastFailure(title, squashAtomCommandFailure(result));
}

type SetWorkerThread = (threadRef: ScopedThreadRef, worker: boolean) => Promise<void>;

/** Moves a thread to the Workers tab, or back to Projects, by setting its "worker" tag. */
function useSetWorkerThread(): SetWorkerThread {
  const setTag = useOrchestrationCommand(threadEnvironment.setTag, { label: "thread worker tag" });
  return async (threadRef, worker) => {
    const result = await setTag({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tag: WORKER_THREAD_TAG, tagged: worker },
    });
    reportCommandFailure(
      worker ? "Could not move thread to Workers" : "Could not move thread to Projects",
      result,
    );
  };
}

// Project thread menus open deep below the sidebar header, which owns the command; menus read it
// at click time.
let setWorkerThreadAction: SetWorkerThread | null = null;

function useProvideSetWorkerThread() {
  const setWorkerThread = useSetWorkerThread();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish the header's command to thread menus opened deep below it, and withdraw it on unmount.
  useEffect(() => {
    setWorkerThreadAction = setWorkerThread;
    return () => {
      if (setWorkerThreadAction === setWorkerThread) setWorkerThreadAction = null;
    };
  });
}

/** "Move to Workers" for a project thread's context menu; `handle` returns whether it took the click. */
export function legacyThreadWorkerMenu(thread: EnvironmentThreadShell) {
  const items = [
    {
      id: "move-to-workers",
      label: "Move to Workers",
      disabled: !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    },
  ];
  const handle = (clicked: string | null): boolean => {
    if (clicked !== "move-to-workers") return false;
    void setWorkerThreadAction?.(scopeThreadRef(thread.environmentId, thread.id), true);
    return true;
  };
  return { items, handle };
}

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
  // The tabs are always mounted with the sidebar, so they publish the project thread menu's command.
  useProvideSetWorkerThread();
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

/** A scheduled job outside a worker thread: in a project thread, in none, or in an archived one. */
interface WorkerEntry {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly thread: SidebarThreadSummary | null;
  readonly state: WorkerState;
}

/**
 * A project thread, open or archived, with the jobs that post into it. A job that starts a new
 * thread each run has no thread of its own, so it gets a row to itself.
 */
interface JobThreadEntry {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly thread: SidebarThreadSummary | null;
  readonly jobs: readonly [WorkerEntry, ...WorkerEntry[]];
  readonly state: WorkerState;
}

/** A thread the user moved to Workers, with the jobs that post into it. */
interface WorkerThreadEntry {
  readonly environmentId: EnvironmentId;
  readonly thread: SidebarThreadSummary;
  readonly jobs: readonly WorkerEntry[];
  readonly state: WorkerState;
}

interface LegacySidebarWorkersProps {
  readonly projects: WorkerProjectIndex;
  readonly routeThreadKey: string | null;
}

interface EnvironmentWorkersProps extends LegacySidebarWorkersProps {
  readonly environmentId: EnvironmentId;
  readonly mode: "needs-you" | "all";
  readonly showArchived: boolean;
}

/** Projects tab: the workers whose latest run needs the user. */
export function LegacySidebarNeedsYou(props: LegacySidebarWorkersProps) {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <EnvironmentWorkers
      key={environmentId}
      environmentId={environmentId}
      mode="needs-you"
      showArchived={false}
      {...props}
    />
  ));
}

/** Workers tab: worker threads by folder, then the jobs that run in project threads. */
export function LegacySidebarWorkersList(props: LegacySidebarWorkersProps) {
  const environmentIds = useConnectedEnvironmentIds();
  const [showArchived, setShowArchived] = useLocalStorage(
    SHOW_ARCHIVED_WORKERS_KEY,
    false,
    Schema.Boolean,
  );
  if (environmentIds.length === 0) {
    return <div className="px-2 pt-4 text-center text-secondary-label text-xs">No workers yet</div>;
  }
  return (
    <>
      {environmentIds.map((environmentId) => (
        <EnvironmentWorkers
          key={environmentId}
          environmentId={environmentId}
          mode="all"
          showArchived={showArchived}
          {...props}
        />
      ))}
      <button
        type="button"
        data-testid="workers-show-archived"
        aria-pressed={showArchived}
        className="mt-1 cursor-pointer px-2 py-1 text-left text-xs text-sidebar-muted-foreground/60 outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
        onClick={() => setShowArchived(!showArchived)}
      >
        {showArchived ? "Hide archived" : "Show archived"}
      </button>
    </>
  );
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

function EnvironmentWorkers(props: EnvironmentWorkersProps) {
  const { environmentId, mode, projects, routeThreadKey, showArchived } = props;
  // Until the thread list loads, every worker would look like its thread was archived.
  const shellsReady = useAllEnvironmentShellsBootstrapped();
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
  const folderView = useFolderView();
  const tasks = tasksQuery.data?.tasks;
  if (!tasks || !shellsReady) return null;

  const shellByKey = new Map(
    threadShells.map((shell) => [
      scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)),
      shell,
    ]),
  );
  const threadPillOf = (thread: SidebarThreadSummary) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return resolveThreadStatusPill({
      thread: {
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          localLastVisitedAtById[threadKey],
        ),
      },
    });
  };
  const jobs: WorkerEntry[] = tasks.map((task) => {
    const threadKey = task.threadId
      ? scopedThreadKey(scopeThreadRef(environmentId, task.threadId))
      : null;
    const thread = threadKey ? (shellByKey.get(threadKey) ?? null) : null;
    // A worker thread speaks for itself, so its jobs only report their own runs.
    const threadPill = thread && !isWorkerThread(thread.source) ? threadPillOf(thread) : null;
    return {
      environmentId,
      task,
      thread,
      state: resolveWorkerState({
        task,
        // Thread lists leave archived threads out, so a worker's missing thread is archived or gone.
        threadClosed: task.threadId !== null && thread === null,
        threadPill,
        dismissedRunAt: dismissedRuns[task.id] ?? null,
      }),
    };
  });
  const jobsByThreadId = new Map<ThreadId, WorkerEntry[]>();
  for (const job of jobs) {
    if (job.thread === null || !isWorkerThread(job.thread.source)) continue;
    const list = jobsByThreadId.get(job.thread.id);
    if (list) list.push(job);
    else jobsByThreadId.set(job.thread.id, [job]);
  }
  const workerThreads: WorkerThreadEntry[] = threadShells
    .filter((thread) => thread.environmentId === environmentId && isWorkerThread(thread.source))
    .map((thread) => {
      const threadJobs = jobsByThreadId.get(thread.id) ?? [];
      return {
        environmentId,
        thread,
        jobs: threadJobs,
        state: resolveWorkerThreadState({
          threadPill: threadPillOf(thread),
          jobStates: threadJobs.map((job) => job.state),
        }),
      };
    });
  // One row per project thread, however many jobs post into it.
  const projectThreadJobs = groupWorkers(
    jobs.filter((job) => job.thread === null || !isWorkerThread(job.thread.source)),
    (job) => (job.task.threadId === null ? `job:${job.task.id}` : `thread:${job.task.threadId}`),
    [],
  ).flatMap((group): JobThreadEntry[] => {
    const [first, ...rest] = group.workers;
    if (!first) return [];
    const threadJobs: JobThreadEntry["jobs"] = [first, ...rest];
    return [
      {
        environmentId,
        threadId: first.task.threadId,
        thread: first.thread,
        jobs: threadJobs,
        state: resolveJobThreadState(threadJobs.map((job) => job.state)),
      },
    ];
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
  const isRouteThread = (threadId: ThreadId | null) =>
    threadId !== null &&
    routeThreadKey === scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const renderJobRows = (entries: readonly JobThreadEntry[]) =>
    entries.map((entry) => (
      <SidebarJobThreadRow
        key={entry.threadId ?? entry.jobs[0].task.id}
        entry={entry}
        isActive={isRouteThread(entry.threadId)}
        showLastRun={mode === "needs-you"}
        onDismiss={dismiss}
      />
    ));
  const renderThreadRows = (entries: readonly WorkerThreadEntry[]) =>
    entries.map((worker) => (
      <SidebarWorkerThreadRow
        key={worker.thread.id}
        worker={worker}
        isActive={isRouteThread(worker.thread.id)}
        showLastRun={mode === "needs-you"}
        onDismiss={dismiss}
      />
    ));

  if (mode === "needs-you") {
    const threadsNeedingYou = workerThreads.filter((worker) => worker.state.needsYou);
    const jobsNeedingYou = projectThreadJobs.filter((worker) => worker.state.needsYou);
    if (threadsNeedingYou.length === 0 && jobsNeedingYou.length === 0) return null;
    return (
      <SidebarMenu className="mb-1">
        <WorkerGroup
          name="Needs you"
          expanded={!collapsedGroups.has(NEEDS_YOU_GROUP_KEY)}
          onToggle={() => toggleGroup(NEEDS_YOU_GROUP_KEY)}
        >
          {renderThreadRows(threadsNeedingYou)}
          {renderJobRows(jobsNeedingYou)}
        </WorkerGroup>
      </SidebarMenu>
    );
  }

  const listedJobs = showArchived
    ? projectThreadJobs
    : projectThreadJobs.filter((worker) => !worker.state.archived);
  if (workerThreads.length === 0 && listedJobs.length === 0) {
    return (
      <div className="px-2 pt-4 text-center text-secondary-label text-xs">
        {jobs.length === 0 ? "No workers yet" : "No active workers"}
      </div>
    );
  }
  const projectKeyOf = (projectId: ProjectId) =>
    projects.byScopedKey.get(scopedProjectKey(scopeProjectRef(environmentId, projectId)))
      ?.projectKey ?? `unknown:${projectId}`;
  const threadGroups = groupWorkers(
    workerThreads,
    (worker) => folderOfThread(worker.thread) ?? UNFILED_WORKERS_KEY,
    folderView.folders,
  );
  const orderedJobs = groupWorkers(
    listedJobs,
    (entry) => projectKeyOf(entry.jobs[0].task.projectId),
    projects.order,
  ).flatMap((group) => group.workers);
  return (
    <SidebarMenu>
      {threadGroups.map((group) => (
        <WorkerGroup
          key={`folder:${group.key}`}
          name={group.key === UNFILED_WORKERS_KEY ? "Unfiled" : group.key}
          expanded={
            group.key === UNFILED_WORKERS_KEY
              ? !folderView.unfiledCollapsed
              : !folderView.collapsed.has(group.key)
          }
          // Folder collapse is the server's, shared with the Projects tab and the phone.
          onToggle={() =>
            setFolderExpanded(
              group.key === UNFILED_WORKERS_KEY ? null : group.key,
              group.key === UNFILED_WORKERS_KEY
                ? folderView.unfiledCollapsed
                : folderView.collapsed.has(group.key),
            )
          }
        >
          {renderThreadRows(group.workers)}
        </WorkerGroup>
      ))}
      {orderedJobs.length > 0 ? (
        <WorkerGroup
          name="Jobs in project threads"
          expanded={!collapsedGroups.has(PROJECT_THREAD_JOBS_GROUP_KEY)}
          onToggle={() => toggleGroup(PROJECT_THREAD_JOBS_GROUP_KEY)}
        >
          {renderJobRows(orderedJobs)}
        </WorkerGroup>
      ) : null}
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

/** Turns each job on or off, skipping the ones already there. */
function useSetJobsEnabled(environmentId: EnvironmentId) {
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "worker enabled",
  });
  return async (tasks: readonly ScheduledTask[], enabled: boolean) => {
    for (const task of tasks) {
      if (task.enabled === enabled) continue;
      reportCommandFailure(
        "Could not update job",
        await setEnabled({ environmentId, input: { id: task.id, enabled } }),
      );
    }
  };
}

/** The job a row reports on when none runs soon: the one that ran last, or changed last. */
function latestJob(tasks: readonly [ScheduledTask, ...ScheduledTask[]]): ScheduledTask {
  const ranAt = (task: ScheduledTask) => task.lastRunAt ?? task.updatedAt;
  return tasks.reduce((latest, task) => (ranAt(task) > ranAt(latest) ? task : latest));
}

/** An archived thread's title. Thread lists leave archived threads out, so it comes from the archive. */
function ArchivedThreadTitle(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  fallback: string;
}) {
  const { snapshots } = useArchivedThreadSnapshots([props.environmentId]);
  const title = snapshots
    .find((entry) => entry.environmentId === props.environmentId)
    ?.snapshot.threads.find((thread) => thread.id === props.threadId)?.title;
  return <>{title ?? props.fallback}</>;
}

function SidebarJobThreadRow(props: {
  entry: JobThreadEntry;
  isActive: boolean;
  showLastRun: boolean;
  onDismiss: (task: ScheduledTask) => void;
}) {
  const { entry, isActive, showLastRun, onDismiss } = props;
  const { environmentId, threadId, thread, jobs, state } = entry;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const setJobsEnabled = useSetJobsEnabled(environmentId);
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "worker run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "worker delete",
  });
  const { unarchiveThread } = useThreadActions();
  const setWorkerThread = useSetWorkerThread();
  const tasks: readonly [ScheduledTask, ...ScheduledTask[]] = [
    jobs[0].task,
    ...jobs.slice(1).map((job) => job.task),
  ];
  const onlyTask = tasks.length === 1 ? tasks[0] : null;
  const latest = latestJob(tasks);
  // Archived threads can't be opened, and the scheduler can't post into them either.
  const threadArchived = threadId !== null && (thread === null || thread.archivedAt !== null);
  const brokenByArchive = threadArchived && state.needsYou;
  const failedJobs = threadArchived
    ? []
    : jobs.filter((job) => job.state.needsYou && job.task.lastRunStatus === "failed");

  const openSettings = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/settings/scheduled-tasks",
      search: onlyTask ? { environmentId, taskId: onlyTask.id } : { environmentId },
    });
  };
  // A job's runs land in its thread, so that is where its history lives, archived or not.
  const open = () => {
    if (threadId === null) {
      openSettings();
      return;
    }
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      search: threadArchived ? { archived: true } : {},
    });
  };
  const handleContextMenu = async (event: React.MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
    const jobsLabel = onlyTask ? "" : " jobs";
    const clicked = await api.contextMenu.show(
      [
        ...(onlyTask ? [{ id: "run-now", label: "Run now", disabled: !canOperate }] : []),
        tasks.some((task) => task.enabled)
          ? { id: "pause", label: `Pause${jobsLabel}`, disabled: !canOperate }
          : { id: "resume", label: `Resume${jobsLabel}`, disabled: !canOperate },
        ...(thread !== null && !threadArchived
          ? [{ id: "move-to-workers", label: "Move thread to Workers", disabled: !canOperate }]
          : []),
        ...(threadArchived
          ? [{ id: "unarchive", label: "Unarchive thread", disabled: !canOperate }]
          : []),
        ...(failedJobs.length > 0 ? [{ id: "dismiss", label: "Mark done" }] : []),
        { id: "edit", label: onlyTask ? "Edit job" : "Edit jobs" },
        ...(onlyTask
          ? [
              {
                id: "delete",
                label: "Delete job",
                destructive: true,
                icon: "trash" as const,
                disabled: !canOperate,
              },
            ]
          : []),
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "edit") return openSettings();
    if (clicked === "dismiss") {
      for (const job of failedJobs) onDismiss(job.task);
      return;
    }
    if (clicked === "move-to-workers" && thread !== null) {
      await setWorkerThread(scopeThreadRef(environmentId, thread.id), true);
      return;
    }
    if (clicked === "unarchive" && threadId !== null) {
      const result = await unarchiveThread(scopeThreadRef(environmentId, threadId));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastFailure("Could not unarchive thread", squashAtomCommandFailure(result));
      }
      return;
    }
    if (clicked === "run-now" && onlyTask) {
      reportCommandFailure(
        "Could not run job",
        await runNow({ environmentId, input: { id: onlyTask.id } }),
      );
      return;
    }
    if (clicked === "pause" || clicked === "resume") {
      await setJobsEnabled(tasks, clicked === "resume");
      return;
    }
    if (clicked !== "delete" || !onlyTask) return;
    const confirmed = await api.dialogs.confirm(
      [`Delete job "${onlyTask.title}"?`, "Its thread and history stay where they are."].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    reportCommandFailure(
      "Could not delete job",
      await remove({ environmentId, input: { id: onlyTask.id } }),
    );
  };

  const nextRunAt = soonestRunAt(tasks);
  const meta = showLastRun ? (
    <RelativeTime compact timestamp={latest.lastRunAt ?? thread?.updatedAt ?? latest.updatedAt} />
  ) : nextRunAt !== null ? (
    <ScheduledRelativeLabel value={nextRunAt} />
  ) : tasks.some((task) => task.enabled && task.schedule.type === "webhook") ? (
    "Webhook"
  ) : !latest.enabled ? (
    <ScheduledStoppedLabel task={latest} />
  ) : latest.lastRunAt !== null ? (
    <RelativeTime compact timestamp={latest.lastRunAt} />
  ) : null;

  return (
    <WorkerRowLayout
      testId={`worker-job-thread-row-${threadId ?? tasks[0].id}`}
      isActive={isActive}
      pill={state.pill}
      title={
        thread?.title ??
        (threadId === null ? (
          tasks[0].title
        ) : (
          <ArchivedThreadTitle
            environmentId={environmentId}
            threadId={threadId}
            fallback={tasks[0].title}
          />
        ))
      }
      tooltip={
        <>
          {tasks.map((task) => `${task.title}: ${scheduleLabel(task.schedule)}`).join(" · ")}
          {brokenByArchive
            ? " · Can't run: its thread is archived"
            : threadArchived
              ? " · Thread archived"
              : ""}
          {tasks.flatMap((task) => (task.lastRunError ? [` · ${task.lastRunError}`] : [])).join("")}
        </>
      }
      meta={meta}
      onOpen={open}
      onContextMenu={handleContextMenu}
    />
  );
}

function SidebarWorkerThreadRow(props: {
  worker: WorkerThreadEntry;
  isActive: boolean;
  showLastRun: boolean;
  onDismiss: (task: ScheduledTask) => void;
}) {
  const { worker, isActive, showLastRun, onDismiss } = props;
  const { environmentId, thread, jobs, state } = worker;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const setJobsEnabled = useSetJobsEnabled(environmentId);
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "worker run now",
  });
  const { archiveThread } = useThreadActions();
  const setWorkerThread = useSetWorkerThread();
  const threadRef = scopeThreadRef(environmentId, thread.id);
  const tasks = jobs.map((job) => job.task);
  const onlyTask = tasks.length === 1 ? tasks[0]! : null;
  const anyEnabled = tasks.some((task) => task.enabled);
  const failedJobs = jobs.filter(
    (job) => job.state.needsYou && job.task.lastRunStatus === "failed",
  );

  const open = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  const openSettings = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/settings/scheduled-tasks",
      search: onlyTask ? { environmentId, taskId: onlyTask.id } : { environmentId },
    });
  };
  const setAllEnabled = (enabled: boolean) => setJobsEnabled(tasks, enabled);
  const handleContextMenu = async (event: React.MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const canOperate = readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
    const jobsLabel = tasks.length === 1 ? "" : " jobs";
    const folderMenu = legacyThreadFolderMenu([thread]);
    const clicked = await api.contextMenu.show(
      [
        { id: "move-to-projects", label: "Move to Projects", disabled: !canOperate },
        ...folderMenu.items,
        ...(onlyTask ? [{ id: "run-now", label: "Run now", disabled: !canOperate }] : []),
        ...(tasks.length === 0
          ? []
          : [
              anyEnabled
                ? { id: "pause", label: `Pause${jobsLabel}`, disabled: !canOperate }
                : { id: "resume", label: `Resume${jobsLabel}`, disabled: !canOperate },
            ]),
        ...(failedJobs.length > 0 ? [{ id: "dismiss", label: "Mark done" }] : []),
        ...(tasks.length > 0 ? [{ id: "edit", label: onlyTask ? "Edit job" : "Edit jobs" }] : []),
        { id: "archive", label: "Archive", disabled: !canOperate },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "move-to-projects") {
      await setWorkerThread(threadRef, false);
      return;
    }
    if (folderMenu.handle(clicked)) return;
    if (clicked === "edit") return openSettings();
    if (clicked === "dismiss") {
      for (const job of failedJobs) onDismiss(job.task);
      return;
    }
    if (clicked === "run-now" && onlyTask) {
      reportCommandFailure(
        "Could not run job",
        await runNow({ environmentId, input: { id: onlyTask.id } }),
      );
      return;
    }
    if (clicked === "pause" || clicked === "resume") {
      await setAllEnabled(clicked === "resume");
      return;
    }
    if (clicked !== "archive") return;
    // Archiving a worker stops it, instead of leaving its jobs to fail into an archived thread.
    await setAllEnabled(false);
    const result = await archiveThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastFailure("Could not archive thread", squashAtomCommandFailure(result));
    }
  };

  const nextRunAt = soonestRunAt(tasks);
  const meta = showLastRun ? (
    <RelativeTime compact timestamp={thread.latestRun?.completedAt ?? thread.updatedAt} />
  ) : nextRunAt !== null ? (
    <ScheduledRelativeLabel value={nextRunAt} />
  ) : tasks.some((task) => task.enabled && task.schedule.type === "webhook") ? (
    "Webhook"
  ) : tasks.length > 0 ? (
    "Paused"
  ) : (
    <RelativeTime compact timestamp={thread.updatedAt} />
  );

  return (
    <WorkerRowLayout
      testId={`worker-thread-row-${thread.id}`}
      isActive={isActive}
      pill={state.pill}
      title={thread.title}
      tooltip={
        tasks.length === 0
          ? "No scheduled jobs"
          : tasks.map((task) => `${task.title}: ${scheduleLabel(task.schedule)}`).join(" · ")
      }
      meta={meta}
      onOpen={open}
      onContextMenu={handleContextMenu}
    />
  );
}

/** The thread row's look, shared by job rows and worker thread rows. */
function WorkerRowLayout(props: {
  testId: string;
  isActive: boolean;
  pill: WorkerState["pill"];
  title: React.ReactNode;
  tooltip: React.ReactNode;
  meta: React.ReactNode;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent) => Promise<void>;
}) {
  const { isActive, onOpen } = props;
  return (
    <SidebarMenuSubItem className="w-full" data-thread-item>
      <div
        role="button"
        tabIndex={0}
        data-active={isActive}
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={props.testId}
        className={cn(
          "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
        onContextMenu={(event) => void props.onContextMenu(event)}
      >
        <div className="flex w-3.5 shrink-0 items-center justify-center">
          {props.pill && <ThreadStatusLabel status={props.pill} compact />}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-sm">{props.title}</span>}
            />
            <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
          </Tooltip>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="flex min-w-12 justify-end max-sm:min-w-20">
            <span
              className={`text-3xs tabular-nums ${isActive ? "text-foreground" : "text-secondary-label"}`}
            >
              {props.meta}
            </span>
          </div>
        </div>
      </div>
    </SidebarMenuSubItem>
  );
}

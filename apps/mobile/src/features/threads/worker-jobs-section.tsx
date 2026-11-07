// Fork (F18): the end of Android's Workers tab: how to make a worker when there is none, then the
// scheduled jobs that post into project threads (or a new thread each run).
import { useAtom, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isWorkerThread, type EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { openSettings } from "../settings/settings-navigation";
import { projectThreadJobs, type WorkerJob, type WorkerJobThread } from "./workerJobs";

const jobsExpandedAtom = Atom.make(true).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-list:worker-jobs-expanded"),
);

function threadKey(environmentId: string, threadId: string) {
  return `${environmentId}:${threadId}`;
}

function sameThreads(
  left: ReadonlyMap<string, WorkerJobThread>,
  right: ReadonlyMap<string, WorkerJobThread>,
) {
  if (left.size !== right.size) return false;
  for (const [key, thread] of right) {
    const other = left.get(key);
    if (
      other === undefined ||
      other.title !== thread.title ||
      other.archived !== thread.archived ||
      other.worker !== thread.worker
    ) {
      return false;
    }
  }
  return true;
}

// Only what the job rows show, so streaming threads don't re-render the section.
let previousJobThreads: ReadonlyMap<string, WorkerJobThread> = new Map();
const jobThreadsAtom = Atom.make((get) => {
  const next = new Map(
    get(environmentThreadShells.threadShellsAtom).map((thread) => [
      threadKey(thread.environmentId, thread.id),
      {
        title: thread.title,
        archived: thread.archivedAt !== null,
        worker: isWorkerThread(thread.source),
      },
    ]),
  );
  if (sameThreads(previousJobThreads, next)) return previousJobThreads;
  previousJobThreads = next;
  return next;
}).pipe(Atom.withLabel("mobile:thread-list:worker-job-threads"));

export const WorkerJobsSection = memo(function WorkerJobsSection(props: {
  readonly workerCount: number;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly pane: "screen" | "sidebar";
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  return (
    <View>
      {props.workerCount === 0 ? (
        <Text
          className={cn(
            "py-6 text-center text-sm",
            sidebarPane ? "px-3 text-drawer-foreground-muted" : "px-5 text-foreground-muted",
          )}
        >
          No workers yet. Long-press a thread and choose Move to Workers.
        </Text>
      ) : null}
      {props.environmentIds.map((environmentId) => (
        <EnvironmentWorkerJobs
          key={environmentId}
          environmentId={environmentId}
          pane={props.pane}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </View>
  );
});

function EnvironmentWorkerJobs(props: {
  readonly environmentId: EnvironmentId;
  readonly pane: "screen" | "sidebar";
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { environmentId } = props;
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  ).data?.tasks;
  const threads = useAtomValue(jobThreadsAtom);
  const nowMs = useNowMinuteMs();
  const [expanded, setExpanded] = useAtom(jobsExpandedAtom);
  const navigation = useNavigation();
  if (tasks === undefined) return null;
  const jobs = projectThreadJobs({
    tasks,
    threadOf: (task) =>
      task.threadId === null
        ? null
        : (threads.get(threadKey(environmentId, task.threadId)) ?? null),
    nowMs,
  });
  if (jobs.length === 0) return null;
  const sidebarPane = props.pane === "sidebar";
  const open = (task: ScheduledTask) => {
    const thread =
      task.threadId === null
        ? null
        : appAtomRegistry.get(
            environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, task.threadId)),
          );
    if (thread && thread.archivedAt === null) props.onOpenThread(thread);
    else openSettings(navigation, "SettingsScheduledTasks");
  };
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Jobs in project threads, ${jobs.length}`}
        accessibilityState={{ expanded }}
        className={cn("mb-1.5 mt-4 flex-row items-center gap-2.5", sidebarPane ? "px-3" : "px-5")}
        onPress={() => setExpanded((current) => !current)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text
          className={cn(
            "text-xs font-t3-medium",
            sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
          )}
        >
          {expanded ? "Jobs in project threads" : `Jobs in project threads (${jobs.length})`}
        </Text>
        <View className={cn("h-px flex-1", sidebarPane ? "bg-drawer-border" : "bg-border")} />
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName={
            sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
          }
          type="monochrome"
        />
      </Pressable>
      {expanded
        ? jobs.map((job) => (
            <WorkerJobRow key={job.task.id} job={job} pane={props.pane} onPress={open} />
          ))
        : null}
    </View>
  );
}

function WorkerJobRow(props: {
  readonly job: WorkerJob;
  readonly pane: "screen" | "sidebar";
  readonly onPress: (task: ScheduledTask) => void;
}) {
  const { job } = props;
  const sidebarPane = props.pane === "sidebar";
  const where =
    job.task.threadId === null ? "New thread each run" : (job.thread?.title ?? "Thread");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={
        job.thread && !job.thread.archived ? "Opens its thread" : "Opens Scheduled tasks"
      }
      className={cn("flex-row items-center gap-2 py-2", sidebarPane ? "pl-3 pr-3" : "pl-5 pr-5")}
      onPress={() => props.onPress(job.task)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="w-3 items-center">
        <SymbolView
          name={job.failed ? "exclamationmark.circle" : "calendar.badge.clock"}
          size={12}
          tintColorClassName={job.failed ? "accent-danger-foreground" : "accent-icon-muted"}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          className={cn("text-sm", sidebarPane ? "text-drawer-foreground" : "text-foreground")}
          numberOfLines={1}
        >
          {job.task.title}
        </Text>
        <Text
          className={cn(
            "text-xs",
            job.failed
              ? "text-danger-foreground"
              : sidebarPane
                ? "text-drawer-foreground-muted"
                : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {`${where} · ${job.status}`}
        </Text>
      </View>
    </Pressable>
  );
}

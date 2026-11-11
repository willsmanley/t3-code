import {
  AUTO_FILE_PENDING_TAG,
  AUTO_FILED_TAG,
  CommandId,
  isAutoFiledThread,
  isListedThreadLineage,
  isWorkerThread,
  type OrchestrationV2AppThreadLineage,
  type ThreadFolderSettings,
  type ThreadId,
  threadFolderOfTags,
  threadFolderTag,
} from "@t3tools/contracts";
import {
  pickThreadFolder,
  type ThreadFolderChoice,
} from "@t3tools/provider-core/server/threadFolderPrompt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  decodeThreadFolderSettingsFile,
  THREAD_FOLDER_SETTINGS_FILE,
} from "./ThreadFolderSettings.ts";

// Fork (F20): auto-filing. The `orchestration.launchThread` handler, which only the user's own
// clients call, tags a thread started with no folder `autofile:pending`. The thread's first title
// call is then offered the folders; when it names one and the thread is still pending and
// unfiled, the thread moves there with an `autofile:filed` mark. The wait always ends there.

const EXAMPLES_PER_FOLDER = 3;
const MAX_EXAMPLE_TITLE_LENGTH = 80;
const PLACEHOLDER_TITLES = new Set(["new thread"]);

interface AutoFileThread {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

export type AutoFileBlocker =
  | "not-pending"
  | "filed"
  | "worker"
  | "subagent"
  | "off"
  | "no-folders";

/** Why the thread can't be auto-filed now, or null when it can. */
export function autoFileBlocker(
  thread: AutoFileThread,
  settings: Pick<ThreadFolderSettings, "autoFile" | "folders">,
): AutoFileBlocker | null {
  if (!(thread.tags ?? []).includes(AUTO_FILE_PENDING_TAG)) return "not-pending";
  // A folder tag means the user (or the default folder) already filed it; never override that.
  if (threadFolderOfTags(thread.tags) !== null) return "filed";
  if (isWorkerThread(thread)) return "worker";
  if (!isListedThreadLineage(thread.lineage)) return "subagent";
  if (!settings.autoFile) return "off";
  if (settings.folders.length === 0) return "no-folders";
  return null;
}

interface ExampleThread extends AutoFileThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
  readonly activeAtMs: number;
}

/**
 * Each folder with a few recent titles, so the model can tell similar folders apart. Threads the
 * user filed by hand come before auto-filed ones, then the most recently active.
 */
export function buildThreadFolderChoice(
  settings: Pick<ThreadFolderSettings, "folders">,
  threads: ReadonlyArray<ExampleThread>,
  excludeThreadId: ThreadId,
): ThreadFolderChoice {
  const byFolder = new Map<string, ExampleThread[]>();
  for (const thread of threads) {
    if (thread.id === excludeThreadId || thread.archivedAt !== null || thread.deletedAt !== null) {
      continue;
    }
    if (!isListedThreadLineage(thread.lineage)) continue;
    const title = thread.title.trim();
    if (title.length === 0 || PLACEHOLDER_TITLES.has(title.toLowerCase())) continue;
    const folder = threadFolderOfTags(thread.tags);
    if (folder === null) continue;
    const list = byFolder.get(folder);
    if (list) list.push(thread);
    else byFolder.set(folder, [thread]);
  }
  return {
    folders: settings.folders.map(({ name }) => ({
      name,
      recentTitles: [...(byFolder.get(name) ?? [])]
        .sort(
          (left, right) =>
            Number(isAutoFiledThread(left.tags)) - Number(isAutoFiledThread(right.tags)) ||
            right.activeAtMs - left.activeAtMs,
        )
        .slice(0, EXAMPLES_PER_FOLDER)
        .map((thread) => thread.title.trim().slice(0, MAX_EXAMPLE_TITLE_LENGTH)),
    })),
  };
}

export interface AutoFileTagWrite {
  readonly tag: string;
  readonly tagged: boolean;
}

/**
 * The tag writes once the model answered (null: no answer or none). A thread that is no longer
 * pending is left alone; one the user filed meanwhile only loses its pending tag.
 */
export function planAutoFileWrites(
  thread: AutoFileThread,
  answer: string | null,
  settings: Pick<ThreadFolderSettings, "autoFile" | "folders"> | null,
): ReadonlyArray<AutoFileTagWrite> {
  const blocker =
    settings === null
      ? (thread.tags ?? []).includes(AUTO_FILE_PENDING_TAG)
        ? "off"
        : "not-pending"
      : autoFileBlocker(thread, settings);
  if (blocker === "not-pending") return [];
  const done = { tag: AUTO_FILE_PENDING_TAG, tagged: false };
  const folder =
    blocker === null && settings !== null
      ? pickThreadFolder(answer, {
          folders: settings.folders.map(({ name }) => ({ name, recentTitles: [] })),
        })
      : null;
  if (folder === null) return [done];
  return [
    { tag: threadFolderTag(folder), tagged: true },
    { tag: AUTO_FILED_TAG, tagged: true },
    done,
  ];
}

export class ThreadAutoFile extends Context.Service<
  ThreadAutoFile,
  {
    /** The folders to offer the title model, or undefined when the thread isn't waiting to be filed. */
    readonly folderChoice: (
      thread: AutoFileThread & { readonly id: ThreadId },
    ) => Effect.Effect<ThreadFolderChoice | undefined>;
    /** Files the thread in the model's folder if it still waits and is unfiled; ends the wait. */
    readonly finish: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly answer: string | null;
    }) => Effect.Effect<void>;
  }
>()("t3/threadFolders/ThreadAutoFile") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const filePath = path.join(config.stateDir, THREAD_FOLDER_SETTINGS_FILE);

  // ThreadFolderSettings owns the file and writes it atomically; this side only reads it.
  const readSettings = fs.readFileString(filePath).pipe(
    Effect.map((contents) => Option.getOrNull(decodeThreadFolderSettingsFile(contents))),
    Effect.orElseSucceed(() => null),
  );

  const folderChoice: ThreadAutoFile["Service"]["folderChoice"] = Effect.fn(
    "ThreadAutoFile.folderChoice",
  )(
    function* (thread) {
      if (!(thread.tags ?? []).includes(AUTO_FILE_PENDING_TAG)) return undefined;
      const settings = yield* readSettings;
      if (settings === null || autoFileBlocker(thread, settings) !== null) return undefined;
      const snapshot = yield* threads.getShellSnapshot({ location: "active" });
      return buildThreadFolderChoice(
        settings,
        snapshot.threads.map((shell) => ({
          ...shell,
          activeAtMs: DateTime.toEpochMillis(shell.latestUserMessageAt ?? shell.updatedAt),
        })),
        thread.id,
      );
    },
    (effect) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not list folders for auto-filing", { error }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
  );

  const finish: ThreadAutoFile["Service"]["finish"] = Effect.fn("ThreadAutoFile.finish")(
    function* (input) {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (shell === null || !(shell.tags ?? []).includes(AUTO_FILE_PENDING_TAG)) return;
      const writes = planAutoFileWrites(shell, input.answer, yield* readSettings);
      for (const [index, write] of writes.entries()) {
        yield* threads.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`${input.requestId}:autofile:${index}`),
          threadId: input.threadId,
          tag: write.tag,
          tagged: write.tagged,
        });
      }
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not auto-file a thread", { threadId: input.threadId, error }),
        ),
      ),
  );

  return ThreadAutoFile.of({ folderChoice, finish });
});

export const layer = Layer.effect(ThreadAutoFile, make);

const disabled = ThreadAutoFile.of({
  folderChoice: Effect.fn("ThreadAutoFile.disabled.folderChoice")(() => Effect.undefined),
  finish: Effect.fn("ThreadAutoFile.disabled.finish")(() => Effect.void),
});

/** The service when the runtime provides it; layers built without it never auto-file. */
export const optional = Effect.serviceOption(ThreadAutoFile).pipe(
  Effect.map(Option.getOrElse(() => disabled)),
);

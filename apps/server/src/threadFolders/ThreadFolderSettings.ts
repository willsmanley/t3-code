import {
  applyThreadFolderUpdate,
  CommandId,
  type OrchestrationV2ThreadShell,
  planThreadFolderTagChange,
  ThreadFolderError,
  ThreadFolderSettings,
  type ThreadFolderUpdateInput,
  type ThreadFolderUpdateResult,
  threadFolderOfTags,
  threadFolderTag,
  type ThreadTag,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

// Fork (F20): the folder list every client shows, and the folder new threads land in. A thread's
// folder stays its `folder:<name>` tag; this file holds order, collapse state and empty folders.

const SETTINGS_FILE_NAME = "thread-folders.json";
const RETAG_CONCURRENCY = 4;

const decodeSettingsFile = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadFolderSettings));
const encodeSettingsFile = Schema.encodeSync(Schema.fromJsonString(ThreadFolderSettings));

export class ThreadFolderSettingsService extends Context.Service<
  ThreadFolderSettingsService,
  {
    /** The settings now, then after every change. */
    readonly changes: Stream.Stream<ThreadFolderSettings, ThreadFolderError>;
    readonly update: (
      input: ThreadFolderUpdateInput,
    ) => Effect.Effect<ThreadFolderUpdateResult, ThreadFolderError>;
    /**
     * Tags for a thread the user starts from a client: the folder they picked (null for none),
     * else the default folder.
     */
    readonly launchTags: (
      folder: string | null | undefined,
    ) => Effect.Effect<ReadonlyArray<ThreadTag>>;
  }
>()("t3/threadFolders/ThreadFolderSettings/ThreadFolderSettingsService") {}

interface SeedThread {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly archivedAt: unknown;
  readonly activeAtMs: number;
}

/** Folders on unarchived threads, most recently active first; an archived thread's tag may be stale. */
export function seedThreadFolderSettings(threads: ReadonlyArray<SeedThread>): ThreadFolderSettings {
  const latestByFolder = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const folder = threadFolderOfTags(thread.tags);
    if (folder === null) continue;
    latestByFolder.set(folder, Math.max(latestByFolder.get(folder) ?? 0, thread.activeAtMs));
  }
  const folders = [...latestByFolder.entries()]
    .sort(
      ([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName),
    )
    .map(([name]) => ({ name, collapsed: false }));
  return { folders, defaultFolder: null, unfiledCollapsed: false, updatedAt: null };
}

const activeAtMs = (thread: OrchestrationV2ThreadShell) =>
  DateTime.toEpochMillis(thread.latestUserMessageAt ?? thread.updatedAt);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const filePath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  const state = yield* Ref.make<Option.Option<ThreadFolderSettings>>(Option.none());
  const lock = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.sliding<ThreadFolderSettings>(1);

  const folderError = (message: string) => (cause: unknown) =>
    new ThreadFolderError({ message, cause });

  /** Unarchived threads, then archived ones (snapshots list those in `archivedThreads`). */
  const listShells = (location: "active" | "archive") =>
    threads.getShellSnapshot({ location }).pipe(
      Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]),
      Effect.mapError(folderError("Could not read the thread list.")),
    );

  const persist = (settings: ThreadFolderSettings) =>
    writeFileStringAtomically({ filePath, contents: encodeSettingsFile(settings) }).pipe(
      Effect.provide(services),
      Effect.mapError(folderError("Could not save the folder list.")),
    );

  const loadUnlocked = Effect.gen(function* () {
    const loaded = yield* Ref.get(state);
    if (Option.isSome(loaded)) return loaded.value;
    const stored = yield* fs.readFileString(filePath).pipe(
      Effect.map(decodeSettingsFile),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(folderError("Could not read the folder list.")(error)),
      ),
    );
    if (Option.isSome(stored)) {
      yield* Ref.set(state, stored);
      return stored.value;
    }
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      yield* Effect.logWarning(
        "Thread folder list was unreadable; rebuilding it from thread tags",
        {
          filePath,
        },
      );
    }
    const active = yield* listShells("active");
    const seeded = seedThreadFolderSettings(
      active
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => ({
          tags: thread.tags,
          archivedAt: thread.archivedAt,
          activeAtMs: activeAtMs(thread),
        })),
    );
    yield* persist(seeded);
    yield* Ref.set(state, Option.some(seeded));
    return seeded;
  });

  const load = lock.withPermit(loadUnlocked);

  const commandId = random.uuidV4().pipe(
    Effect.map((uuid) => CommandId.make(`server:thread-folders:${uuid}`)),
    Effect.orDie,
  );

  /** Puts every thread in folder `from`, archived ones included, in `to` (null: no folder). */
  const retag = Effect.fn("ThreadFolderSettings.retag")(function* (
    from: string,
    to: string | null,
  ) {
    const all = [...(yield* listShells("active")), ...(yield* listShells("archive"))];
    const moving = all.filter(
      (thread) => thread.deletedAt === null && threadFolderOfTags(thread.tags) === from,
    );
    const failures = yield* Effect.forEach(
      moving,
      (thread) =>
        Effect.gen(function* () {
          const change = planThreadFolderTagChange(thread.tags, to);
          const writes = [
            ...(change.add === null ? [] : [{ tag: change.add, tagged: true }]),
            ...change.remove.map((tag) => ({ tag, tagged: false })),
          ];
          for (const write of writes) {
            yield* threads.dispatch({
              type: "thread.tag.set",
              commandId: yield* commandId,
              threadId: thread.id,
              tag: write.tag,
              tagged: write.tagged,
            });
          }
          return 0;
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not retag a thread for a folder change", {
              threadId: thread.id,
              error,
            }).pipe(Effect.as(1)),
          ),
        ),
      { concurrency: RETAG_CONCURRENCY },
    );
    return failures.reduce((sum, failed) => sum + failed, 0);
  });

  const update: ThreadFolderSettingsService["Service"]["update"] = Effect.fn(
    "ThreadFolderSettings.update",
  )(function* (input) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const current = yield* loadUnlocked;
        const now = DateTime.formatIso(yield* DateTime.now);
        const next = applyThreadFolderUpdate(current, input, now);
        if (next !== current) {
          yield* persist(next);
          yield* Ref.set(state, Option.some(next));
          yield* PubSub.publish(changesPubSub, next);
        }
        const unmovedThreads =
          input._tag === "rename" && input.from !== input.to
            ? yield* retag(input.from, input.to)
            : input._tag === "delete"
              ? yield* retag(input.name, null)
              : 0;
        return { settings: next, unmovedThreads };
      }),
    );
  });

  const changes: ThreadFolderSettingsService["Service"]["changes"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading so a change in between still arrives.
      const subscription = yield* PubSub.subscribe(changesPubSub);
      const current = yield* load;
      return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription));
    }),
  );

  const launchTags: ThreadFolderSettingsService["Service"]["launchTags"] = (folder) => {
    if (folder === null) return Effect.succeed([]);
    if (folder !== undefined) return Effect.succeed([threadFolderTag(folder)]);
    return load.pipe(
      Effect.map((settings) =>
        settings.defaultFolder === null ? [] : [threadFolderTag(settings.defaultFolder)],
      ),
      // A thread must still start when the folder list can't be read.
      Effect.catch((error) =>
        Effect.logWarning("Could not read the default thread folder", { error }).pipe(
          Effect.as([]),
        ),
      ),
    );
  };

  return ThreadFolderSettingsService.of({ changes, update, launchTags });
});

export const layer = Layer.effect(ThreadFolderSettingsService, make);

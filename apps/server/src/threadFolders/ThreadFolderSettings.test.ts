import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ThreadId,
  type ThreadFolderSettings as Settings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  layer,
  seedThreadFolderSettings,
  ThreadFolderSettingsService,
} from "./ThreadFolderSettings.ts";

const settings = (
  folders: ReadonlyArray<readonly [string, boolean]>,
  extra: Partial<Settings> = {},
): Settings => ({
  folders: folders.map(([name, collapsed]) => ({ name, collapsed })),
  defaultFolder: null,
  unfiledCollapsed: false,
  updatedAt: null,
  ...extra,
});

it("seeds folders from unarchived threads, most recently active first", () => {
  const seeded = seedThreadFolderSettings([
    { tags: ["folder:Work"], archivedAt: null, activeAtMs: 10 },
    { tags: ["folder:School", "worker"], archivedAt: null, activeAtMs: 30 },
    { tags: ["folder:Work"], archivedAt: null, activeAtMs: 40 },
    // An archived thread can keep a folder another device deleted.
    { tags: ["folder:Old"], archivedAt: "2026-01-01", activeAtMs: 99 },
    { tags: ["folder:Old", "folder:Todo"], archivedAt: null, activeAtMs: 20 },
    { tags: [], archivedAt: null, activeAtMs: 50 },
  ]);
  assert.deepStrictEqual(
    seeded,
    settings([
      ["Work", false],
      ["School", false],
      ["Todo", false],
    ]),
  );
});

const at = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const shell = (id: string, tags: string[], extra: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: ThreadId.make(id),
    tags,
    archivedAt: null,
    deletedAt: null,
    updatedAt: at,
    latestUserMessageAt: null,
    ...extra,
  }) as OrchestrationV2ThreadShell;

const withService = <A, E>(
  shells: {
    readonly active: OrchestrationV2ThreadShell[];
    readonly archive: OrchestrationV2ThreadShell[];
  },
  body: (input: {
    readonly service: ThreadFolderSettingsService["Service"];
    readonly dispatched: OrchestrationV2ServerCommand[];
    readonly baseDir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-thread-folders-" });
    const dispatched: OrchestrationV2ServerCommand[] = [];
    return yield* Effect.gen(function* () {
      const service = yield* ThreadFolderSettingsService;
      return yield* body({ service, dispatched, baseDir });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(dispatched.length)),
            ),
          ),
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              // Like the projection store: archived shells come back in `archivedThreads`.
              getShellSnapshot: (options) =>
                Effect.succeed({
                  threads: options?.location === "archive" ? [] : shells.active,
                  archivedThreads: options?.location === "active" ? [] : shells.archive,
                } as never),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  return {} as never;
                }),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const tagWrites = (dispatched: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  dispatched.flatMap((command) =>
    command.type === "thread.tag.set" ? [[command.threadId, command.tag, command.tagged]] : [],
  );

it.layer(NodeServices.layer)("ThreadFolderSettingsService", (it) => {
  it.effect("seeds from thread tags on first read and keeps the file", () =>
    withService(
      { active: [shell("a", ["folder:Work"]), shell("b", ["folder:Todo"])], archive: [] },
      ({ service, baseDir }) =>
        Effect.gen(function* () {
          const first = yield* service.changes.pipe(Stream.take(1), Stream.runHead);
          assert.deepStrictEqual(
            first._tag === "Some" ? first.value.folders.map((entry) => entry.name) : [],
            ["Todo", "Work"],
          );
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stored = yield* fs.readFileString(
            path.join(baseDir, "userdata", "thread-folders.json"),
          );
          assert.include(stored, '"Work"');
        }),
    ),
  );

  it.effect("rename and delete retag every thread, archived ones too", () =>
    withService(
      {
        active: [
          shell("active", ["worker", "folder:Work"]),
          shell("other", ["folder:Todo"]),
          shell("deleted", ["folder:Work"], { deletedAt: at }),
        ],
        archive: [shell("archived", ["folder:Work"], { archivedAt: at })],
      },
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const renamed = yield* service.update({ _tag: "rename", from: "Work", to: "Jobs" });
          assert.equal(renamed.unmovedThreads, 0);
          assert.deepStrictEqual(
            renamed.settings.folders.map((entry) => entry.name),
            ["Todo", "Jobs"],
          );
          assert.deepStrictEqual(tagWrites(dispatched), [
            ["active", "folder:Jobs", true],
            ["active", "folder:Work", false],
            ["archived", "folder:Jobs", true],
            ["archived", "folder:Work", false],
          ]);
          dispatched.length = 0;
          const deleted = yield* service.update({ _tag: "delete", name: "Todo" });
          assert.deepStrictEqual(
            deleted.settings.folders.map((entry) => entry.name),
            ["Jobs"],
          );
          assert.deepStrictEqual(tagWrites(dispatched), [["other", "folder:Todo", false]]);
        }),
    ),
  );

  it.effect("a launch gets the picked folder, else the default", () =>
    withService({ active: [], archive: [] }, ({ service }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* service.launchTags(undefined), []);
        yield* service.update({ _tag: "setDefault", name: "Todo" });
        assert.deepStrictEqual(yield* service.launchTags(undefined), ["folder:Todo"]);
        assert.deepStrictEqual(yield* service.launchTags("School"), ["folder:School"]);
        assert.deepStrictEqual(yield* service.launchTags(null), []);
      }),
    ),
  );
});

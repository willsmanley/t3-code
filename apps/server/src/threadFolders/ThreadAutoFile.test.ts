import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
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

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  autoFileBlocker,
  buildThreadFolderChoice,
  layer,
  planAutoFileWrites,
  ThreadAutoFile,
} from "./ThreadAutoFile.ts";

const settings = (names: string[], extra: Partial<Settings> = {}): Settings => ({
  folders: names.map((name) => ({ name, collapsed: false })),
  defaultFolder: null,
  unfiledCollapsed: false,
  newThreadProjectId: null,
  autoFile: true,
  updatedAt: null,
  ...extra,
});

const lineage = (id: string, relationshipToParent: "fork" | "subagent" | null = null) => ({
  parentThreadId: relationshipToParent === null ? null : ThreadId.make("parent"),
  relationshipToParent,
  rootThreadId: ThreadId.make(id),
});

const shell = (
  id: string,
  title: string,
  tags: string[],
  activeAt = "2026-11-10T00:00:00.000Z",
  extra: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    title,
    tags,
    lineage: lineage(id),
    archivedAt: null,
    deletedAt: null,
    updatedAt: DateTime.makeUnsafe(activeAt),
    latestUserMessageAt: null,
    ...extra,
  }) as OrchestrationV2ThreadShell;

const PENDING = "autofile:pending";
const folders = settings(["Personal", "Jobs"]);

it("decides which threads may be auto-filed", () => {
  const cases: ReadonlyArray<
    readonly [string, string[], Partial<Settings>, ReturnType<typeof autoFileBlocker>]
  > = [
    ["a pending, unfiled thread", [PENDING], {}, null],
    ["never asked to wait (MCP, delegate_task, scheduled tasks)", [], {}, "not-pending"],
    ["the user filed it before the answer", [PENDING, "folder:Jobs"], {}, "filed"],
    ["a worker", [PENDING, "worker"], {}, "worker"],
    ["the switch went off", [PENDING], { autoFile: false }, "off"],
    ["every folder was deleted", [PENDING], { folders: [] }, "no-folders"],
  ];
  for (const [name, tags, extra, expected] of cases) {
    assert.strictEqual(
      autoFileBlocker({ tags, lineage: lineage("t") }, { ...folders, ...extra }),
      expected,
      name,
    );
  }
  assert.strictEqual(
    autoFileBlocker({ tags: [PENDING], lineage: lineage("t", "subagent") }, folders),
    "subagent",
  );
});

it("offers each folder with recent titles, hand-filed threads first", () => {
  const choice = buildThreadFolderChoice(
    settings(["Personal", "Jobs", "Empty"]),
    [
      shell("new", "This thread", [PENDING]),
      shell(
        "auto",
        "Auto-filed newest",
        ["folder:Personal", "autofile:filed"],
        "2026-11-10T09:00:00.000Z",
      ),
      shell("hand-old", "Passport photos", ["folder:Personal"], "2026-11-01T00:00:00.000Z"),
      shell("hand-new", "Dentist refund", ["folder:Personal"], "2026-11-09T00:00:00.000Z"),
      shell("hand-3", "Grocery order", ["folder:Personal"], "2026-11-08T00:00:00.000Z"),
      shell("placeholder", "New thread", ["folder:Jobs"]),
      shell("archived", "Old job", ["folder:Jobs"], undefined, {
        archivedAt: DateTime.makeUnsafe("2026-11-02T00:00:00.000Z"),
      }),
      shell("job", "Handshake interview prep", ["folder:Jobs"]),
      shell("child", "Subagent work", ["folder:Jobs"], undefined, {
        lineage: lineage("child", "subagent"),
      }),
    ].map((thread) => ({ ...thread, activeAtMs: DateTime.toEpochMillis(thread.updatedAt) })),
    ThreadId.make("new"),
  );
  assert.deepStrictEqual(choice, {
    folders: [
      { name: "Personal", recentTitles: ["Dentist refund", "Grocery order", "Passport photos"] },
      { name: "Jobs", recentTitles: ["Handshake interview prep"] },
      { name: "Empty", recentTitles: [] },
    ],
  });
});

it("files the thread only while it still waits and is unfiled", () => {
  const fileInJobs = [
    { tag: "folder:Jobs", tagged: true },
    { tag: "autofile:filed", tagged: true },
    { tag: PENDING, tagged: false },
  ];
  const done = [{ tag: PENDING, tagged: false }];
  const cases: ReadonlyArray<
    readonly [string, string[], string | null, Settings | null, ReadonlyArray<unknown>]
  > = [
    ["the model picked a folder", [PENDING], "Jobs", folders, fileInJobs],
    ["names match loosely", [PENDING], ' "jobs" ', folders, fileInJobs],
    ["none leaves it in Unfiled", [PENDING], null, folders, done],
    ["a folder that isn't offered is none", [PENDING], "Taxes", folders, done],
    [
      "the user moved it meanwhile: never override",
      [PENDING, "folder:Personal"],
      "Jobs",
      folders,
      done,
    ],
    ["the user's move already ended the wait", ["folder:Personal"], "Jobs", folders, []],
    ["the switch went off meanwhile", [PENDING], "Jobs", { ...folders, autoFile: false }, done],
    ["the folder list can't be read", [PENDING], "Jobs", null, done],
  ];
  for (const [name, tags, answer, current, expected] of cases) {
    assert.deepStrictEqual(
      planAutoFileWrites({ tags, lineage: lineage("t") }, answer, current),
      expected,
      name,
    );
  }
});

const withAutoFile = <A, E>(
  input: { readonly thread: OrchestrationV2ThreadShell; readonly settings: Settings | null },
  body: (input: {
    readonly service: ThreadAutoFile["Service"];
    readonly dispatched: OrchestrationV2ServerCommand[];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-autofile-" });
    const config = ServerConfig.layerTest(process.cwd(), baseDir);
    const stateDir = yield* Effect.map(ServerConfig.ServerConfig, (c) => c.stateDir).pipe(
      Effect.provide(config),
    );
    if (input.settings !== null) {
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "thread-folders.json"),
        JSON.stringify(input.settings),
      );
    }
    const dispatched: OrchestrationV2ServerCommand[] = [];
    let thread = input.thread;
    return yield* Effect.gen(function* () {
      return yield* body({ service: yield* ThreadAutoFile, dispatched });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(config),
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(thread),
              getShellSnapshot: () =>
                Effect.succeed({
                  threads: [thread, shell("job", "Interview prep", ["folder:Jobs"])],
                  archivedThreads: [],
                } as never),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  if (command.type === "thread.tag.set") {
                    const tags = thread.tags ?? [];
                    thread = {
                      ...thread,
                      tags: command.tagged
                        ? [...tags, command.tag]
                        : tags.filter((tag) => tag !== command.tag),
                    };
                  }
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
    command.type === "thread.tag.set" ? [[command.tag, command.tagged, command.commandId]] : [],
  );

it.layer(NodeServices.layer)("ThreadAutoFile", (it) => {
  const requestId = CommandId.make("cmd:title");

  it.effect("offers folders only to a thread waiting to be filed, then files it", () =>
    withAutoFile(
      { thread: shell("new", "New thread", [PENDING]), settings: folders },
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const choice = yield* service.folderChoice({
            id: ThreadId.make("new"),
            tags: [PENDING],
            lineage: lineage("new"),
          });
          assert.deepStrictEqual(
            choice?.folders.map((folder) => folder.name),
            ["Personal", "Jobs"],
          );
          assert.strictEqual(
            yield* service.folderChoice({
              id: ThreadId.make("x"),
              tags: [],
              lineage: lineage("x"),
            }),
            undefined,
          );
          yield* service.finish({ threadId: ThreadId.make("new"), requestId, answer: "Jobs" });
          assert.deepStrictEqual(tagWrites(dispatched), [
            ["folder:Jobs", true, "cmd:title:autofile:0"],
            ["autofile:filed", true, "cmd:title:autofile:1"],
            [PENDING, false, "cmd:title:autofile:2"],
          ]);
          // A second answer for the same thread finds nothing left to do.
          yield* service.finish({ threadId: ThreadId.make("new"), requestId, answer: "Personal" });
          assert.strictEqual(dispatched.length, 3);
        }),
    ),
  );

  it.effect("without a folder file, ends the wait and offers nothing", () =>
    withAutoFile(
      { thread: shell("new", "New thread", [PENDING]), settings: null },
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          assert.strictEqual(
            yield* service.folderChoice({
              id: ThreadId.make("new"),
              tags: [PENDING],
              lineage: lineage("new"),
            }),
            undefined,
          );
          yield* service.finish({ threadId: ThreadId.make("new"), requestId, answer: "Jobs" });
          assert.deepStrictEqual(tagWrites(dispatched), [[PENDING, false, "cmd:title:autofile:0"]]);
        }),
    ),
  );
});

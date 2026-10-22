import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type ScheduledTask, ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list()
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:older")));
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")));
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false });
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }));
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const serviceLayerWith = (
  threadLaunch: Partial<ThreadLaunchService.ThreadLaunchService["Service"]> = {},
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)(threadLaunch),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );

const serviceLayer = serviceLayerWith();

/** Launches succeed, so a due run completes. */
const launchingServiceLayer = serviceLayerWith({
  launch: () =>
    Effect.succeed({ threadId: ThreadId.make("thread:scheduled"), resumed: false } as never),
});

const taskInput = (schedule: unknown, extra: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:schedule-controls",
    title: "Review",
    prompt: "Review the open pull requests.",
    enabled: true,
    schedule,
    projectId: "project-schedule-controls",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...extra,
  });

/**
 * Pins the clock before the service starts: its scheduler polls every five
 * seconds, so moving a fresh test clock to 2026 afterwards would replay decades of polls.
 */
const withService = <A, E>(
  at: string,
  body: Effect.Effect<A, E, ScheduledTaskService.ScheduledTaskService>,
  layer = serviceLayer,
) =>
  TestClock.setTime(Date.parse(at)).pipe(
    Effect.andThen(body.pipe(Effect.provide(layer))),
    Effect.provide(SqlitePersistence.layerMemory),
  );

it.effect("keeps a stored time zone when a save omits it and removes it on null", () =>
  withService(
    "2026-07-03T10:00:00.000Z",
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const zoned = { type: "fixed_time", timeOfDay: "09:00", timeZone: "America/Chicago" };
      const created = yield* service.upsert(yield* taskInput(zoned));
      expect(created.task.schedule).toEqual(zoned);
      expect(created.task.nextRunAt).toBe("2026-07-03T14:00:00.000Z");

      // A client that predates time zones sends the schedule without one.
      const kept = yield* service.upsert(
        yield* taskInput({ type: "fixed_time", timeOfDay: "09:00" }, { title: "Renamed" }),
      );
      expect(kept.task.schedule).toEqual(zoned);
      expect(kept.task.nextRunAt).toBe("2026-07-03T14:00:00.000Z");

      const cleared = yield* service.upsert(
        yield* taskInput({ type: "fixed_time", timeOfDay: "09:00", timeZone: null }),
      );
      expect(cleared.task.schedule).toEqual({ type: "fixed_time", timeOfDay: "09:00" });
    }),
  ),
);

/** The task list once `matches` holds for the first task, as subscribers see it. */
const awaitTask = (matches: (task: ScheduledTask) => boolean) =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const seen = yield* Deferred.make<ScheduledTask>();
    yield* service.subscribeList().pipe(
      Stream.runForEach(({ tasks }) =>
        tasks[0] !== undefined && matches(tasks[0])
          ? Deferred.succeed(seen, tasks[0])
          : Effect.void,
      ),
      Effect.forkChild,
    );
    return Deferred.await(seen);
  });

it.effect("defers a run that comes due outside its active hours without running it", () =>
  Effect.gen(function* () {
    // 16:30 in Chicago.
    yield* TestClock.setTime(Date.parse("2026-07-03T21:30:00.000Z"));
    const created = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* service.upsert(
        yield* taskInput({
          type: "interval",
          everyMs: 20 * 60_000,
          activeHours: { start: "09:00", end: "17:00", timeZone: "America/Chicago" },
        }),
      );
    }).pipe(Effect.provide(serviceLayer));
    expect(created.task.nextRunAt).toBe("2026-07-03T21:50:00.000Z");

    // The server was down past the window, so the 16:50 run is due at 03:00.
    yield* TestClock.setTime(Date.parse("2026-07-04T08:00:00.000Z"));
    yield* Effect.gen(function* () {
      const deferred = yield* awaitTask((task) => task.nextRunAt !== created.task.nextRunAt);
      yield* TestClock.adjust("6 seconds");
      const task = yield* deferred;
      expect(task.nextRunAt).toBe("2026-07-04T14:00:00.000Z");
      expect(task.lastRunStatus).toBe("never");
      expect(task.runCount).toBe(0);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("runs a one-off once, then keeps it listed and switched off until a new time", () =>
  withService(
    "2026-07-03T10:00:00.000Z",
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const once = { type: "once", at: "2026-07-03T05:02:00-05:00" };
      const created = yield* service.upsert(yield* taskInput(once));
      expect(created.task.schedule).toEqual({ type: "once", at: "2026-07-03T10:02:00.000Z" });
      expect(created.task.nextRunAt).toBe("2026-07-03T10:02:00.000Z");

      const ran = yield* awaitTask((task) => task.lastRunStatus === "succeeded");
      yield* TestClock.adjust("3 minutes");
      const finished = yield* ran;
      expect(finished.enabled).toBe(false);
      expect(finished.nextRunAt).toBeNull();
      expect(finished.runCount).toBe(1);
      expect(finished.lastRunAt).toBe("2026-07-03T10:02:00.000Z");

      const resume = yield* service
        .setEnabled({ id: created.task.id, enabled: true })
        .pipe(Effect.flip);
      expect(resume.message).toContain("time has passed");
      // Unchanged and switched off, its other fields stay editable.
      const renamed = yield* service.upsert(
        yield* taskInput(once, { enabled: false, title: "Renamed" }),
      );
      expect(renamed.task.title).toBe("Renamed");
      const stale = yield* service.upsert(yield* taskInput(once)).pipe(Effect.flip);
      expect(stale.message).toBe("A one-off task needs a time in the future.");

      const rearmed = yield* service.upsert(
        yield* taskInput({ type: "once", at: "2026-07-03T12:00:00.000Z" }),
      );
      expect(rearmed.task.enabled).toBe(true);
      expect(rearmed.task.nextRunAt).toBe("2026-07-03T12:00:00.000Z");
      expect(rearmed.task.lastRunStatus).toBe("succeeded");
    }),
    launchingServiceLayer,
  ),
);

it.effect("rejects a one-off time that has already passed", () =>
  withService(
    "2026-07-03T10:00:00.000Z",
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      for (const enabled of [true, false]) {
        const failure = yield* service
          .upsert(yield* taskInput({ type: "once", at: "2026-07-03T09:59:00.000Z" }, { enabled }))
          .pipe(Effect.flip);
        expect(failure.message).toBe("A one-off task needs a time in the future.");
      }
      expect((yield* service.list()).tasks).toEqual([]);
    }),
  ),
);

it.effect("skips a one-off missed while the server was down and switches it off", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-03T10:00:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(yield* taskInput({ type: "once", at: "2026-07-03T10:02:00.000Z" }));
    }).pipe(Effect.provide(serviceLayer));

    yield* TestClock.setTime(Date.parse("2026-07-03T10:30:00.000Z"));
    yield* Effect.gen(function* () {
      const skipped = yield* awaitTask((task) => !task.enabled);
      yield* TestClock.adjust("6 seconds");
      const task = yield* skipped;
      expect(task.nextRunAt).toBeNull();
      expect(task.lastRunStatus).toBe("never");
      expect(task.runCount).toBe(0);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("switches an interval task off after its run limit and keeps it listed", () =>
  withService(
    "2026-07-03T10:00:00.000Z",
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 60_000, endAfterRuns: 2 }),
      );
      expect(created.task.nextRunAt).toBe("2026-07-03T10:01:00.000Z");

      const ended = yield* awaitTask((task) => !task.enabled);
      yield* TestClock.adjust("5 minutes");
      const task = yield* ended;
      expect(task.runCount).toBe(2);
      expect(task.nextRunAt).toBeNull();
      expect(task.lastRunStatus).toBe("succeeded");

      const resume = yield* service.setEnabled({ id: task.id, enabled: true }).pipe(Effect.flip);
      expect(resume.message).toContain("limit of 2");
      const keep = yield* service
        .upsert(yield* taskInput({ type: "interval", everyMs: 60_000 }))
        .pipe(Effect.flip);
      expect(keep.message).toContain("limit of 2");
      const raised = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 60_000, endAfterRuns: 3 }),
      );
      expect(raised.task.enabled).toBe(true);
      expect(raised.task.nextRunAt).not.toBeNull();
    }),
    launchingServiceLayer,
  ),
);

it.effect("switches a fixed-time task off when its next run would be after the end time", () =>
  withService(
    "2026-07-03T08:00:00.000Z",
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const daily = { type: "fixed_time", timeOfDay: "09:00", timeZone: "UTC" };
      const created = yield* service.upsert(
        yield* taskInput({ ...daily, endAt: "2026-07-04T08:00:00Z" }),
      );
      expect(created.task.schedule).toMatchObject({ endAt: "2026-07-04T08:00:00.000Z" });
      expect(created.task.nextRunAt).toBe("2026-07-03T09:00:00.000Z");

      const ended = yield* awaitTask((task) => !task.enabled);
      yield* TestClock.adjust("2 hours");
      const task = yield* ended;
      expect(task.runCount).toBe(1);
      expect(task.nextRunAt).toBeNull();

      const stale = yield* service.upsert(yield* taskInput(daily)).pipe(Effect.flip);
      expect(stale.message).toContain("end time");
      // Without the end, the task runs again; null removes a stored end.
      const reopened = yield* service.upsert(yield* taskInput({ ...daily, endAt: null }));
      expect(reopened.task.nextRunAt).toBe("2026-07-04T09:00:00.000Z");
      expect(reopened.task.schedule).not.toHaveProperty("endAt");
    }),
    launchingServiceLayer,
  ),
);

it.effect("keeps stored ends when a save omits them, even across trigger types", () =>
  withService(
    "2026-07-03T08:00:00.000Z",
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const ends = { endAfterRuns: 5, endAt: "2026-08-01T00:00:00.000Z" };
      yield* service.upsert(yield* taskInput({ type: "interval", everyMs: 60_000, ...ends }));
      const switched = yield* service.upsert(
        yield* taskInput({ type: "fixed_time", timeOfDay: "09:00" }),
      );
      expect(switched.task.schedule).toMatchObject(ends);
      const cleared = yield* service.upsert(
        yield* taskInput({ type: "fixed_time", timeOfDay: "09:00", endAfterRuns: null }),
      );
      expect(cleared.task.schedule).not.toHaveProperty("endAfterRuns");
      expect(cleared.task.schedule).toMatchObject({ endAt: ends.endAt });
    }),
  ),
);

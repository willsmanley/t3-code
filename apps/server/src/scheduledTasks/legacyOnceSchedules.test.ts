import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { migrateLegacyOnceSchedules } from "./legacyOnceSchedules.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeEffect(ScheduledTaskUpsertInput);

it.effect("rewrites the fork's old one-off rows to upstream's runAt", () =>
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
      const sql = yield* SqlClient.SqlClient;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:legacy-once",
        title: "Check in",
        prompt: "Check on the listing.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-legacy-once",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.upsert(input);
      const legacy = JSON.stringify({ type: "once", at: "2026-11-05T16:00:00.000Z" });
      yield* sql`UPDATE scheduled_tasks SET schedule_json = ${legacy}`;

      yield* migrateLegacyOnceSchedules;
      yield* migrateLegacyOnceSchedules;

      const [task] = (yield* service.list()).tasks;
      expect(task?.schedule).toEqual({ type: "once", runAt: "2026-11-05T16:00:00.000Z" });
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

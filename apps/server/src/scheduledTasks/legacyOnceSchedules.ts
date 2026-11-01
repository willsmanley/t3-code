import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Before upstream added one-off tasks as `{ type: "once", runAt }`, the fork
 * stored its own as `{ type: "once", at }`. Rewrite those rows so they decode
 * (fork, docs/fork/features.md F4).
 */
export const migrateLegacyOnceSchedules = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly task_id: string }>`
    UPDATE scheduled_tasks
    SET schedule_json = json_object('type', 'once', 'runAt', json_extract(schedule_json, '$.at'))
    WHERE json_valid(schedule_json)
      AND json_extract(schedule_json, '$.type') = 'once'
      AND json_type(schedule_json, '$.at') = 'text'
      AND json_type(schedule_json, '$.runAt') IS NULL
    RETURNING task_id
  `;
  if (rows.length > 0) {
    yield* Effect.logInfo("Converted fork one-off scheduled tasks to upstream's format", {
      count: rows.length,
    });
  }
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning("Could not convert fork one-off scheduled tasks", { cause }),
  ),
);

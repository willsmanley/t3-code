import {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class DirectPushDevicePersistenceError extends Schema.TaggedError<DirectPushDevicePersistenceError>()(
  "DirectPushDevicePersistenceError",
  {
    operation: Schema.Literals([
      "create-table",
      "upsert",
      "list",
      "remove",
      "remove-token",
      "remove-session",
      "mark-delivered",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} direct push device registrations.`;
  }
}

export const DirectPushDevice = Schema.Struct({
  deviceId: Schema.String,
  pushToken: Schema.String,
  packageName: Schema.String,
  sessionId: Schema.String,
  preferences: Schema.fromJsonString(RelayAgentAwarenessPreferences),
  /** The card this device last showed: the baseline that decides whether a change alerts. */
  lastAggregate: Schema.NullOr(Schema.fromJsonString(RelayAgentActivityAggregateState)),
});
export type DirectPushDevice = typeof DirectPushDevice.Type;

const encodePreferences = Schema.encodeSync(Schema.fromJsonString(RelayAgentAwarenessPreferences));
const encodeAggregate = Schema.encodeSync(
  Schema.NullOr(Schema.fromJsonString(RelayAgentActivityAggregateState)),
);

export class DirectPushDevices extends Context.Service<
  DirectPushDevices,
  {
    readonly upsert: (input: {
      readonly deviceId: string;
      readonly pushToken: string;
      readonly packageName: string;
      readonly sessionId: string;
      readonly preferences: RelayAgentAwarenessPreferences;
      readonly updatedAt: string;
    }) => Effect.Effect<void, DirectPushDevicePersistenceError>;
    readonly list: Effect.Effect<ReadonlyArray<DirectPushDevice>, DirectPushDevicePersistenceError>;
    readonly remove: (deviceId: string) => Effect.Effect<void, DirectPushDevicePersistenceError>;
    /** Leaves the row when the device registered a newer token in the meantime. */
    readonly removeToken: (input: {
      readonly deviceId: string;
      readonly pushToken: string;
    }) => Effect.Effect<void, DirectPushDevicePersistenceError>;
    readonly removeForSession: (
      sessionId: string,
    ) => Effect.Effect<void, DirectPushDevicePersistenceError>;
    readonly markDelivered: (input: {
      readonly deviceId: string;
      readonly pushToken: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => Effect.Effect<void, DirectPushDevicePersistenceError>;
  }
>()("t3/notifications/DirectPushDevices") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Not a numbered migration: this table exists only in the fork, and the
  // migrator skips every id up to the highest one recorded. A fork-local id
  // would collide with the next upstream migration and stop the server.
  yield* sql`
    CREATE TABLE IF NOT EXISTS direct_push_devices (
      device_id TEXT PRIMARY KEY,
      push_token TEXT NOT NULL,
      package_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      preferences_json TEXT NOT NULL,
      last_aggregate_json TEXT,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `.pipe(
    Effect.mapError(
      (cause) => new DirectPushDevicePersistenceError({ operation: "create-table", cause }),
    ),
    // Direct push is optional; a failure here must not keep the server from starting.
    Effect.catch((error) =>
      Effect.logWarning("direct push device table unavailable", { error: error.message }),
    ),
  );

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DirectPushDevice,
    execute: () => sql`
      SELECT
        device_id AS "deviceId",
        push_token AS "pushToken",
        package_name AS "packageName",
        session_id AS "sessionId",
        preferences_json AS "preferences",
        last_aggregate_json AS "lastAggregate"
      FROM direct_push_devices
      ORDER BY device_id
    `,
  });

  return DirectPushDevices.of({
    upsert: Effect.fn("DirectPushDevices.upsert")(function* (input) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // A token identifies one app install; a reinstall that kept its
            // token must not leave a second row delivering the same pushes.
            yield* sql`
              DELETE FROM direct_push_devices
              WHERE push_token = ${input.pushToken} AND device_id <> ${input.deviceId}
            `;
            yield* sql`
              INSERT INTO direct_push_devices (
                device_id,
                push_token,
                package_name,
                session_id,
                preferences_json,
                last_aggregate_json,
                updated_at
              )
              VALUES (
                ${input.deviceId},
                ${input.pushToken},
                ${input.packageName},
                ${input.sessionId},
                ${encodePreferences(input.preferences)},
                NULL,
                ${input.updatedAt}
              )
              ON CONFLICT (device_id) DO UPDATE SET
                push_token = excluded.push_token,
                package_name = excluded.package_name,
                session_id = excluded.session_id,
                preferences_json = excluded.preferences_json,
                updated_at = excluded.updated_at
            `;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new DirectPushDevicePersistenceError({ operation: "upsert", cause }),
          ),
        );
    }),
    list: listRows(undefined).pipe(
      Effect.mapError(
        (cause) => new DirectPushDevicePersistenceError({ operation: "list", cause }),
      ),
      Effect.withSpan("DirectPushDevices.list"),
    ),
    remove: Effect.fn("DirectPushDevices.remove")(function* (deviceId) {
      yield* sql`DELETE FROM direct_push_devices WHERE device_id = ${deviceId}`.pipe(
        Effect.mapError(
          (cause) => new DirectPushDevicePersistenceError({ operation: "remove", cause }),
        ),
      );
    }),
    removeToken: Effect.fn("DirectPushDevices.removeToken")(function* (input) {
      yield* sql`
        DELETE FROM direct_push_devices
        WHERE device_id = ${input.deviceId} AND push_token = ${input.pushToken}
      `.pipe(
        Effect.mapError(
          (cause) => new DirectPushDevicePersistenceError({ operation: "remove-token", cause }),
        ),
      );
    }),
    removeForSession: Effect.fn("DirectPushDevices.removeForSession")(function* (sessionId) {
      yield* sql`DELETE FROM direct_push_devices WHERE session_id = ${sessionId}`.pipe(
        Effect.mapError(
          (cause) => new DirectPushDevicePersistenceError({ operation: "remove-session", cause }),
        ),
      );
    }),
    markDelivered: Effect.fn("DirectPushDevices.markDelivered")(function* (input) {
      yield* sql`
        UPDATE direct_push_devices
        SET last_aggregate_json = ${encodeAggregate(input.aggregate)}
        WHERE device_id = ${input.deviceId} AND push_token = ${input.pushToken}
      `.pipe(
        Effect.mapError(
          (cause) => new DirectPushDevicePersistenceError({ operation: "mark-delivered", cause }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DirectPushDevices, make);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  type AuthClientSession,
  AuthSessionId,
  DIRECT_PUSH_NOTIFICATION_USER_ID,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { makeAggregateState } from "@t3tools/shared/agentActivityAggregate";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as DirectPush from "./DirectPush.ts";
import * as DirectPushDevices from "./DirectPushDevices.ts";
import * as FcmClient from "./FcmClient.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const SECOND_THREAD_ID = ThreadId.make("thread-2");
const SESSION_ID = AuthSessionId.make("session-1");
const OTHER_SESSION_ID = AuthSessionId.make("session-2");
const preferences: RelayAgentAwarenessPreferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const registration = {
  deviceId: "device-1",
  pushToken: "token-1",
  packageName: "com.example.t3code",
  preferences,
  sessionId: SESSION_ID,
};
const serviceAccount = new TextEncoder().encode(
  JSON.stringify({
    project_id: "fork-project",
    client_email: "push@fork-project.iam.gserviceaccount.com",
    private_key: "unused-by-the-fake-sender",
  }),
);

function state(
  overrides: Partial<RelayAgentActivityState> & Pick<RelayAgentActivityState, "phase">,
): RelayAgentActivityState {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: THREAD_ID,
    projectTitle: "Project",
    threadTitle: "Thread",
    headline: "Working",
    modelTitle: "Model",
    updatedAt: NOW,
    deepLink: `/threads/environment-1/${THREAD_ID}`,
    ...overrides,
  };
}

type SendInput = Parameters<FcmClient.FcmClient["Service"]["send"]>[0];

function activeSession(sessionId: AuthSessionId): AuthClientSession {
  return {
    sessionId,
    subject: "phone",
    scopes: [],
    method: "bearer-access-token",
    client: { deviceType: "mobile" },
    issuedAt: DateTime.makeUnsafe(NOW),
    expiresAt: DateTime.makeUnsafe("2026-11-24T12:00:00.000Z"),
    lastConnectedAt: null,
    connected: false,
    current: false,
  };
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly configured?: boolean;
    readonly respond?: (
      attempt: number,
    ) => Effect.Effect<FcmClient.FcmSendResult, FcmClient.FcmSendError>;
    readonly sessionChanges?: Stream.Stream<SessionStore.SessionCredentialChange>;
    /** Shared across harnesses to model a server restart over the same database. */
    readonly database?: Context.Context<SqlClient.SqlClient>;
    /** False models the window after startup before the active threads are republished. */
    readonly loaded?: boolean;
  } = {},
) {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
  const values = new Map<string, Uint8Array>(
    options.configured === false ? [] : [[FcmClient.FCM_SERVICE_ACCOUNT_SECRET, serviceAccount]],
  );
  const sends: SendInput[] = [];
  const fcm = FcmClient.FcmClient.of({
    send: (input) =>
      Effect.suspend(() => {
        sends.push(input);
        return options.respond?.(sends.length) ?? Effect.succeed("sent" as const);
      }),
  });
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: () => Effect.die("unused"),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  });
  const sessions = { active: [SESSION_ID, OTHER_SESSION_ID] as ReadonlyArray<AuthSessionId> };
  const database =
    options.database ?? (yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" })));
  const context = yield* Layer.build(
    DirectPush.layer.pipe(
      Layer.provideMerge(DirectPushDevices.layer),
      Layer.provide(Layer.succeed(FcmClient.FcmClient, fcm)),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "unused",
            legacyCookieName: undefined,
            streamChanges: options.sessionChanges ?? Stream.never,
            listActive: () => Effect.sync(() => sessions.active.map(activeSession)),
          }),
          NodeCrypto.layer,
        ),
      ),
      Layer.provide(Layer.succeedContext(database)),
    ),
  );
  const push = Context.get(context, DirectPush.DirectPush);
  if (options.loaded !== false) yield* push.markSnapshotLoaded;
  return {
    push,
    devices: Context.get(context, DirectPushDevices.DirectPushDevices),
    sql: Context.get(database, SqlClient.SqlClient),
    database,
    sends,
    sessions,
  };
});

describe("resolveDirectPushDelivery", () => {
  const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));

  it("alerts only on the transition, against the card the device last showed", () => {
    const running = state({ phase: "running" });
    const replay = DirectPush.resolveDirectPushDelivery({
      deviceId: "device-1",
      preferences,
      previousAggregate: null,
      previousThreadPhases: {},
      states: [running],
      jobState: null,
      replay: true,
      nowMs,
    });
    assert.equal(replay?.alertIdentity, null);
    assert.equal(replay?.data?.active, "true");
    assert.equal(replay?.data?.user_id, DIRECT_PUSH_NOTIFICATION_USER_ID);

    const waiting = state({ phase: "waiting_for_input" });
    const transition = DirectPush.resolveDirectPushDelivery({
      deviceId: "device-1",
      preferences,
      previousAggregate: replay?.deliveredAggregate ?? null,
      previousThreadPhases: replay?.threadPhases ?? {},
      states: [waiting],
      jobState: waiting,
      replay: false,
      nowMs,
    });
    assert.equal(transition?.data?.alert_title, "Thread");
    assert.equal(transition?.data?.alert_body, "Input: Project");
    assert.equal(transition?.data?.alert_path, waiting.deepLink);

    const repeat = DirectPush.resolveDirectPushDelivery({
      deviceId: "device-1",
      preferences,
      previousAggregate: transition?.deliveredAggregate ?? null,
      previousThreadPhases: transition?.threadPhases ?? {},
      states: [waiting],
      jobState: waiting,
      replay: false,
      nowMs,
    });
    assert.equal(repeat?.alertIdentity, null);
  });

  it("still alerts without the ongoing card, but shows no card", () => {
    const completed = state({ phase: "completed" });
    const delivery = DirectPush.resolveDirectPushDelivery({
      deviceId: "device-1",
      preferences: { ...preferences, liveActivitiesEnabled: false },
      previousAggregate: null,
      previousThreadPhases: {},
      states: [completed],
      jobState: completed,
      replay: false,
      nowMs,
    });
    assert.equal(delivery?.data?.alert_body, "Done: Project");
    assert.equal(delivery?.data?.active, "false");
    assert.equal(delivery?.deliveredAggregate, null);
  });

  it("never alerts for a phase the device already heard about, with or without the card", () => {
    const waiting = state({ phase: "waiting_for_approval" });
    const otherThread = state({ phase: "running", threadId: SECOND_THREAD_ID });
    for (const liveActivitiesEnabled of [true, false]) {
      const delivery = DirectPush.resolveDirectPushDelivery({
        deviceId: "device-1",
        preferences: { ...preferences, liveActivitiesEnabled },
        // Card from before the restart, rebuilt from only the rows seen so far.
        previousAggregate: makeAggregateState({
          activeStates: [otherThread],
          terminalState: null,
          nowMs,
        }),
        previousThreadPhases: { [THREAD_ID]: "waiting_for_approval" },
        states: [otherThread, waiting],
        jobState: waiting,
        replay: false,
        nowMs,
      });
      assert.equal(delivery?.alertIdentity, null);
      assert.deepEqual(delivery?.threadPhases, { [THREAD_ID]: "waiting_for_approval" });
    }
  });
});

describe("DirectPush", () => {
  it.effect("registers a device and replays the current card", () =>
    Effect.gen(function* () {
      const { push, devices, sends } = yield* makeHarness();
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.lengthOf(sends, 1);
      assert.deepInclude(sends[0], {
        token: "token-1",
        packageName: "com.example.t3code",
        alert: false,
      });
      assert.deepInclude(sends[0]!.data, {
        device_id: "device-1",
        user_id: DIRECT_PUSH_NOTIFICATION_USER_ID,
        active: "true",
        activity_title: "1 active agent",
      });
      const [stored] = yield* devices.list;
      assert.equal(stored?.lastAggregate?.activeCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("alerts registered devices when a thread needs input", () =>
    Effect.gen(function* () {
      const { push, sends } = yield* makeHarness();
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.registerDevice(registration);
      yield* push.drain;
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "waiting_for_input" }) });
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "waiting_for_input" }) });
      yield* push.drain;
      assert.lengthOf(sends, 2);
      assert.isTrue(sends[1]!.alert);
      assert.equal(sends[1]!.data.alert_title, "Thread");
      assert.match(sends[1]!.data.alert_id ?? "", /^[0-9a-f]{64}$/);

      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.isFalse(sends[2]!.alert);
    }).pipe(Effect.scoped),
  );

  it.effect("ends the card when the last thread is removed", () =>
    Effect.gen(function* () {
      const { push, sends } = yield* makeHarness();
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.publish({
        threadId: SECOND_THREAD_ID,
        state: state({ phase: "running", threadId: SECOND_THREAD_ID }),
      });
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.equal(sends[0]!.data.activity_active_count, "2");
      yield* push.publish({ threadId: THREAD_ID, state: null });
      yield* push.publish({ threadId: SECOND_THREAD_ID, state: null });
      yield* push.drain;
      assert.equal(sends.at(-1)!.data.active, "false");
    }).pipe(Effect.scoped),
  );

  it.effect("retries transient Firebase failures with backoff", () =>
    Effect.gen(function* () {
      const { push, devices, sends } = yield* makeHarness({
        respond: (attempt) =>
          attempt === 1
            ? Effect.fail(
                new FcmClient.FcmSendError({ stage: "send", status: 503, retryable: true }),
              )
            : Effect.succeed("sent"),
      });
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.lengthOf(sends, 1);
      assert.equal((yield* devices.list)[0]?.lastAggregate, null);

      yield* TestClock.adjust("1 second");
      yield* push.drain;
      assert.lengthOf(sends, 2);
      assert.equal((yield* devices.list)[0]?.lastAggregate?.activeCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not retry a request Firebase rejected", () =>
    Effect.gen(function* () {
      const { push, sends } = yield* makeHarness({
        respond: () =>
          Effect.fail(new FcmClient.FcmSendError({ stage: "send", status: 400, retryable: false })),
      });
      yield* push.registerDevice(registration);
      yield* push.drain;
      yield* TestClock.adjust("5 minutes");
      yield* push.drain;
      assert.lengthOf(sends, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a device whose token Firebase rejects", () =>
    Effect.gen(function* () {
      const { push, devices, sends } = yield* makeHarness({
        respond: () => Effect.succeed("invalid-token"),
      });
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.lengthOf(yield* devices.list, 0);
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.drain;
      assert.lengthOf(sends, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps one row per token and forgets unregistered devices", () =>
    Effect.gen(function* () {
      const { push, devices } = yield* makeHarness();
      yield* push.registerDevice(registration);
      yield* push.registerDevice({ ...registration, deviceId: "device-2" });
      assert.deepEqual(
        (yield* devices.list).map((device) => device.deviceId),
        ["device-2"],
      );
      yield* push.unregisterDevice({ deviceId: "device-2", sessionId: SESSION_ID });
      assert.lengthOf(yield* devices.list, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects registration until a service account is configured", () =>
    Effect.gen(function* () {
      const { push, devices } = yield* makeHarness({ configured: false });
      assert.isFalse(yield* push.enabled);
      const error = yield* push.registerDevice(registration).pipe(Effect.flip);
      assert.equal(error._tag, "DirectPushUnavailableError");
      assert.lengthOf(yield* devices.list, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("stops delivering once the registering session is no longer active", () =>
    Effect.gen(function* () {
      const { push, devices, sends, sessions } = yield* makeHarness();
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.lengthOf(sends, 1);
      // Revoked from another process (`t3 auth session revoke`) or expired.
      sessions.active = [];
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.drain;
      assert.lengthOf(sends, 1);
      assert.lengthOf(yield* devices.list, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("neither shrinks the card nor repeats alerts after a restart", () =>
    Effect.gen(function* () {
      const before = yield* makeHarness();
      yield* before.push.registerDevice(registration);
      const card = [
        state({ phase: "waiting_for_approval", threadId: ThreadId.make("a") }),
        state({ phase: "waiting_for_input", threadId: ThreadId.make("b") }),
        state({ phase: "running", threadId: ThreadId.make("c") }),
      ];
      for (const row of card) yield* before.push.publish({ threadId: row.threadId, state: row });
      yield* before.push.drain;
      assert.equal((yield* before.devices.list)[0]?.lastAggregate?.activeCount, 3);

      const after = yield* makeHarness({ database: before.database, loaded: false });
      yield* after.push.registerDevice(registration);
      for (const row of [card[2]!, card[0]!, card[1]!]) {
        yield* after.push.publish({ threadId: row.threadId, state: row });
      }
      yield* after.push.drain;
      assert.lengthOf(after.sends, 0);

      yield* after.push.markSnapshotLoaded;
      yield* after.push.drain;
      assert.isAbove(after.sends.length, 0);
      for (const send of after.sends) {
        assert.equal(send.data.activity_active_count, "3");
        assert.isFalse(send.alert);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("alerts once per phase even when a republish changes updatedAt", () =>
    Effect.gen(function* () {
      const { push, sends } = yield* makeHarness();
      yield* push.registerDevice({
        ...registration,
        preferences: { ...preferences, liveActivitiesEnabled: false },
      });
      yield* push.drain;
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "waiting_for_approval" }) });
      yield* TestClock.adjust("10 seconds");
      yield* push.publish({
        threadId: THREAD_ID,
        state: state({ phase: "waiting_for_approval", updatedAt: "2026-10-24T12:00:10.000Z" }),
      });
      yield* push.drain;
      // The card is off, so a republish with nothing new sends nothing at all.
      assert.deepEqual(
        sends.map((send) => send.alert),
        [false, true],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("alerts again when a thread returns to a phase after leaving it", () =>
    Effect.gen(function* () {
      const { push, sends } = yield* makeHarness();
      yield* push.registerDevice({
        ...registration,
        preferences: { ...preferences, liveActivitiesEnabled: false },
      });
      yield* push.drain;
      for (const phase of ["waiting_for_approval", "running", "waiting_for_approval"] as const) {
        yield* TestClock.adjust("10 seconds");
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* push.publish({ threadId: THREAD_ID, state: state({ phase, updatedAt }) });
        yield* push.drain;
      }
      assert.lengthOf(
        sends.filter((send) => send.alert),
        2,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("skips and removes an undecodable registration without failing the others", () =>
    Effect.gen(function* () {
      const { push, devices, sends, sql } = yield* makeHarness();
      yield* push.registerDevice(registration);
      yield* push.drain;
      yield* sql`
        INSERT INTO direct_push_devices (
          device_id, push_token, package_name, session_id, preferences_json, updated_at
        )
        VALUES ('device-0', 'token-0', 'com.example.t3code', ${SESSION_ID}, '{', ${NOW})
      `;
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.drain;
      assert.deepEqual(
        sends.map((send) => send.token),
        ["token-1", "token-1"],
      );
      assert.deepEqual(
        (yield* devices.list).map((device) => device.deviceId),
        ["device-1"],
      );
      const [remaining] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM direct_push_devices
      `;
      assert.equal(remaining?.count, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("re-registration resets the saved card baseline", () =>
    Effect.gen(function* () {
      const { push, devices } = yield* makeHarness({
        respond: (attempt) =>
          attempt === 1
            ? Effect.succeed("sent")
            : Effect.fail(
                new FcmClient.FcmSendError({ stage: "send", status: 400, retryable: false }),
              ),
      });
      yield* push.publish({ threadId: THREAD_ID, state: state({ phase: "running" }) });
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.equal((yield* devices.list)[0]?.lastAggregate?.activeCount, 1);
      yield* push.registerDevice(registration);
      yield* push.drain;
      assert.isNull((yield* devices.list)[0]?.lastAggregate);
    }).pipe(Effect.scoped),
  );

  it.effect("only lets the owning session, or the same phone, change a registration", () =>
    Effect.gen(function* () {
      const { push, devices, sessions } = yield* makeHarness();
      yield* push.registerDevice(registration);
      const hijack = yield* push
        .registerDevice({ ...registration, pushToken: "token-x", sessionId: OTHER_SESSION_ID })
        .pipe(Effect.flip);
      assert.equal(hijack._tag, "DirectPushDeviceNotOwnedError");
      const removal = yield* push
        .unregisterDevice({ deviceId: "device-1", sessionId: OTHER_SESSION_ID })
        .pipe(Effect.flip);
      assert.equal(removal._tag, "DirectPushDeviceNotOwnedError");
      assert.equal((yield* devices.list)[0]?.pushToken, "token-1");

      // A new pairing of the same phone proves itself with the phone's token.
      yield* push.registerDevice({ ...registration, sessionId: OTHER_SESSION_ID });
      assert.equal((yield* devices.list)[0]?.sessionId, OTHER_SESSION_ID);
      yield* push.unregisterDevice({
        deviceId: "device-1",
        pushToken: "token-1",
        sessionId: SESSION_ID,
      });
      assert.lengthOf(yield* devices.list, 0);

      // A registration whose session has ended no longer belongs to anyone.
      yield* push.registerDevice(registration);
      sessions.active = [OTHER_SESSION_ID];
      yield* push.registerDevice({
        ...registration,
        pushToken: "token-x",
        sessionId: OTHER_SESSION_ID,
      });
      assert.equal((yield* devices.list)[0]?.pushToken, "token-x");
    }).pipe(Effect.scoped),
  );

  it.effect("forgets a revoked client's devices", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
      const handled = yield* Deferred.make<void>();
      const { push, devices } = yield* makeHarness({
        sessionChanges: Stream.fromQueue(changes).pipe(
          Stream.take(1),
          Stream.concat(Stream.fromEffectDrain(Deferred.succeed(handled, undefined))),
        ),
      });
      yield* push.registerDevice(registration);
      yield* push.start();
      yield* Queue.offer(changes, { type: "clientRemoved", sessionId: SESSION_ID });
      yield* Deferred.await(handled);
      assert.lengthOf(yield* devices.list, 0);
    }).pipe(Effect.scoped),
  );
});

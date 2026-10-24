import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  DIRECT_PUSH_NOTIFICATION_USER_ID,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly configured?: boolean;
    readonly respond?: (
      attempt: number,
    ) => Effect.Effect<FcmClient.FcmSendResult, FcmClient.FcmSendError>;
    readonly sessionChanges?: Stream.Stream<SessionStore.SessionCredentialChange>;
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
          }),
          NodeCrypto.layer,
        ),
      ),
      Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );
  return {
    push: Context.get(context, DirectPush.DirectPush),
    devices: Context.get(context, DirectPushDevices.DirectPushDevices),
    sends,
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
      states: [running],
      jobState: null,
      replay: true,
      nowMs,
    });
    assert.equal(replay?.alertIdentity, null);
    assert.equal(replay?.data.active, "true");
    assert.equal(replay?.data.user_id, DIRECT_PUSH_NOTIFICATION_USER_ID);

    const waiting = state({ phase: "waiting_for_input" });
    const transition = DirectPush.resolveDirectPushDelivery({
      deviceId: "device-1",
      preferences,
      previousAggregate: replay?.deliveredAggregate ?? null,
      states: [waiting],
      jobState: waiting,
      replay: false,
      nowMs,
    });
    assert.equal(transition?.data.alert_title, "Thread");
    assert.equal(transition?.data.alert_body, "Input: Project");
    assert.equal(transition?.data.alert_path, waiting.deepLink);

    const repeat = DirectPush.resolveDirectPushDelivery({
      deviceId: "device-1",
      preferences,
      previousAggregate: transition?.deliveredAggregate ?? null,
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
      states: [completed],
      jobState: completed,
      replay: false,
      nowMs,
    });
    assert.equal(delivery?.data.alert_body, "Done: Project");
    assert.equal(delivery?.data.active, "false");
    assert.equal(delivery?.deliveredAggregate, null);
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
      yield* push.unregisterDevice("device-2");
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

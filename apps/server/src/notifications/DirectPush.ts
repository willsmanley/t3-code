import {
  type AuthSessionId,
  DIRECT_PUSH_NOTIFICATION_USER_ID,
  DirectPushDeviceNotOwnedError,
  type DirectPushDeviceRegistrationInput,
  type DirectPushDeviceUnregistrationInput,
  DirectPushUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import {
  RelayAgentActivityState,
  type RelayAgentActivityAggregateState,
  type RelayAgentAwarenessPhase,
  type RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "@t3tools/shared/agentActivityAggregate";
import {
  androidActivityData,
  androidAlertForAggregate,
  androidAlertForState,
  fitFcmData,
} from "@t3tools/shared/agentActivityFcmPayloads";
import {
  isExpiredAgentActivityState,
  isTerminalPhase,
} from "@t3tools/shared/agentActivityPayloads";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as DirectPushDevices from "./DirectPushDevices.ts";
import * as FcmClient from "./FcmClient.ts";

// Matches the relay's FCM queue: a delivery older than this would only show
// stale work, and the next publish or app foreground repaints the card.
const DELIVERY_MAX_AGE_MS = 5 * 60_000;
const DELIVERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

const encodeState = Schema.encodeSync(Schema.fromJsonString(RelayAgentActivityState));

export class DirectPushSessionCheckError extends Schema.TaggedError<DirectPushSessionCheckError>()(
  "DirectPushSessionCheckError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check which clients may receive direct push notifications.";
  }
}

interface DeliveryJob {
  readonly deviceId: string;
  readonly pushToken: string;
  /** Null for registration replays. */
  readonly threadId: ThreadId | null;
  /** The thread change that queued this delivery; null for removals and replays. */
  readonly state: RelayAgentActivityState | null;
  readonly replay: boolean;
  readonly queuedAt: number;
  readonly attempt: number;
}

/**
 * The relay's Android delivery decision (FcmDeliveries.process) for a single
 * environment. The card is rebuilt from current rows when the delivery runs,
 * so a late retry still shows the newest state, and alerts compare against the
 * card the device last received.
 *
 * Unlike the relay, an alert also needs the thread's phase to differ from the
 * one the device last heard about. A republished state carries a new
 * `updatedAt`, so the phone's own alert-id dedupe cannot catch it.
 */
export function resolveDirectPushDelivery(input: {
  readonly deviceId: string;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly previousThreadPhases: Readonly<Record<string, RelayAgentAwarenessPhase>>;
  readonly states: ReadonlyArray<RelayAgentActivityState>;
  readonly jobState: RelayAgentActivityState | null;
  readonly replay: boolean;
  readonly nowMs: number;
}): {
  readonly data: Record<string, string>;
  readonly alertIdentity: string | null;
  readonly acknowledge: boolean;
  readonly deliveredAggregate: RelayAgentActivityAggregateState | null;
  readonly threadPhases: Record<string, RelayAgentAwarenessPhase>;
} | null {
  const { preferences, previousAggregate, previousThreadPhases, jobState, nowMs } = input;
  const unseen = (row: { readonly threadId: string; readonly phase: RelayAgentAwarenessPhase }) =>
    previousThreadPhases[row.threadId] !== row.phase;
  const state =
    jobState === null ? undefined : input.states.find((row) => row.threadId === jobState.threadId);
  const stateIsCurrent =
    jobState !== null &&
    state !== undefined &&
    state.phase === jobState.phase &&
    state.updatedAt === jobState.updatedAt;
  const aggregate = makeAggregateState({
    activeStates: preferences.liveActivitiesEnabled ? input.states : [],
    terminalState: null,
    nowMs,
  });
  let alert: ReturnType<typeof androidAlertForState | typeof androidAlertForAggregate> = null;
  // A removal can observe another thread's newly finished state. It repaints
  // the card but leaves that transition for the finished thread's own delivery.
  const acknowledge = jobState !== null || input.replay || aggregate === null;
  if (jobState !== null && preferences.notificationsEnabled) {
    if (previousAggregate === null && !stateIsCurrent) return null;
    if (preferences.liveActivitiesEnabled && previousAggregate !== null && aggregate !== null) {
      alert = androidAlertForAggregate({
        previousAggregate,
        nextAggregate: { ...aggregate, activities: aggregate.activities.filter(unseen) },
        preferences,
        nowMs,
      });
    } else if (
      state !== undefined &&
      stateIsCurrent &&
      unseen(state) &&
      !isExpiredAgentActivityState(state, nowMs)
    ) {
      alert = androidAlertForState(state, preferences, nowMs);
    }
  }
  // A thread's phase is recorded by its own delivery, so another thread's
  // delivery that happens to show it cannot swallow its alert. A replay shows
  // the whole card, so it records every thread.
  const threadPhases: Record<string, RelayAgentAwarenessPhase> = {};
  for (const row of input.states) {
    const seen = input.replay ? row.phase : previousThreadPhases[row.threadId];
    if (seen !== undefined) threadPhases[row.threadId] = seen;
  }
  if (jobState !== null && stateIsCurrent) threadPhases[jobState.threadId] = jobState.phase;
  const displayedAggregate =
    preferences.notificationsEnabled && preferences.liveActivitiesEnabled ? aggregate : null;
  if (!displayedAggregate && !alert && !previousAggregate && jobState !== null) return null;
  return {
    data: {
      t3_kind: "agent_activity",
      device_id: input.deviceId,
      user_id: DIRECT_PUSH_NOTIFICATION_USER_ID,
      updated_at: String(nowMs),
      ...androidActivityData(displayedAggregate),
      ...alert,
    },
    alertIdentity: alert?.alert_id ?? null,
    acknowledge,
    // Finished rows stay in the baseline so replaying the finished card cannot alert again.
    deliveredAggregate: preferences.liveActivitiesEnabled ? aggregate : null,
    threadPhases,
  };
}

/** Rows that can no longer appear on any card. */
function isRetiredState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (isTerminalPhase(state)) {
    return nowMs - Date.parse(state.updatedAt) > TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
  }
  return isExpiredAgentActivityState(state, nowMs);
}

export class DirectPush extends Context.Service<
  DirectPush,
  {
    /** True while a usable Firebase service account is in the secret store. */
    readonly enabled: Effect.Effect<boolean>;
    /**
     * A session may replace a registration it made, one whose session has
     * ended, or one holding the same push token: only that phone has it.
     */
    readonly registerDevice: (
      input: DirectPushDeviceRegistrationInput & { readonly sessionId: AuthSessionId },
    ) => Effect.Effect<
      void,
      | DirectPushUnavailableError
      | DirectPushDeviceNotOwnedError
      | DirectPushSessionCheckError
      | DirectPushDevices.DirectPushDevicePersistenceError
    >;
    readonly unregisterDevice: (
      input: DirectPushDeviceUnregistrationInput & { readonly sessionId: AuthSessionId },
    ) => Effect.Effect<
      void,
      | DirectPushDeviceNotOwnedError
      | DirectPushSessionCheckError
      | DirectPushDevices.DirectPushDevicePersistenceError
    >;
    /** Records a thread's activity and queues deliveries; never waits on Firebase. */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void>;
    /**
     * Deliveries wait for this: until every active thread is back after a
     * restart, a card built from the rows seen so far would shrink and the
     * missing threads would alert again when they reappear.
     */
    readonly markSnapshotLoaded: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/DirectPush") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const devices = yield* DirectPushDevices.DirectPushDevices;
  const fcm = yield* FcmClient.FcmClient;
  const sessions = yield* SessionStore.SessionStore;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  // The relay keeps these rows in its database; one environment's rows are
  // rebuilt from the startup snapshot that AgentAwarenessRelay publishes.
  const rows = new Map<ThreadId, RelayAgentActivityState>();

  const readAccount = FcmClient.readFcmServiceAccount(secrets);
  const enabled = readAccount.pipe(Effect.map(Option.isSome));
  // Read from the database on every check, so a revocation by `t3 auth`
  // in another process or a session that expired counts too.
  const activeSessionIds = sessions.listActive().pipe(
    Effect.map((active) => new Set<string>(active.map((session) => session.sessionId))),
    Effect.mapError((cause) => new DirectPushSessionCheckError({ cause })),
  );

  let enqueue: (job: DeliveryJob) => Effect.Effect<unknown> = () => Effect.void;

  const scheduleRetry = Effect.fn("DirectPush.scheduleRetry")(function* (
    job: DeliveryJob,
    error: FcmClient.FcmSendError,
  ) {
    const delayMs = DELIVERY_RETRY_DELAYS_MS[job.attempt];
    if (delayMs === undefined) {
      yield* Effect.logWarning("direct push delivery retry budget exhausted", {
        deviceId: job.deviceId,
        error: error.message,
      });
      return;
    }
    yield* Effect.logInfo("direct push delivery failed; retrying", {
      deviceId: job.deviceId,
      attempt: job.attempt + 1,
      delayMs,
      error: error.message,
    });
    yield* Effect.sleep(delayMs).pipe(
      Effect.andThen(Effect.suspend(() => enqueue({ ...job, attempt: job.attempt + 1 }))),
      Effect.forkIn(scope),
    );
  });

  const deliver = Effect.fn("DirectPush.deliver")(
    function* (job: DeliveryJob) {
      const now = yield* DateTime.now;
      const nowMs = now.epochMilliseconds;
      if (nowMs - job.queuedAt > DELIVERY_MAX_AGE_MS) return;
      const account = yield* readAccount;
      if (Option.isNone(account)) return;
      const found = yield* devices.get(job.deviceId);
      if (Option.isNone(found) || found.value.pushToken !== job.pushToken) return;
      const device = found.value;
      if (!(yield* activeSessionIds).has(device.sessionId)) {
        yield* Effect.logInfo("direct push client session ended; removing its devices", {
          deviceId: device.deviceId,
        });
        yield* devices.removeForSession(device.sessionId);
        return;
      }
      const delivery = resolveDirectPushDelivery({
        deviceId: device.deviceId,
        preferences: device.preferences,
        previousAggregate: device.lastAggregate,
        previousThreadPhases: device.threadPhases,
        states: [...rows.values()],
        jobState: job.state,
        replay: job.replay,
        nowMs,
      });
      if (delivery === null) return;
      const data = { ...delivery.data };
      if (delivery.alertIdentity !== null) {
        // A grouped alert's identity lists every thread in it; hash it rather
        // than spend FCM's 4 KB payload on ids. The phone deduplicates by it.
        const digest = yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(delivery.alertIdentity),
        );
        data.alert_id = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      const result = yield* fcm
        .send({
          account: account.value,
          token: device.pushToken,
          packageName: device.packageName,
          alert: delivery.alertIdentity !== null,
          data: fitFcmData(data),
        })
        .pipe(
          Effect.catchTags({
            FcmSendError: (error) =>
              (error.retryable
                ? scheduleRetry(job, error)
                : Effect.logWarning("direct push delivery rejected", {
                    deviceId: job.deviceId,
                    error: error.message,
                  })
              ).pipe(Effect.as("failed" as const)),
          }),
        );
      if (result === "failed") return;
      if (result === "invalid-token") {
        yield* Effect.logWarning("Firebase rejected a device token; removing the device", {
          deviceId: device.deviceId,
        });
        yield* devices.removeToken({ deviceId: device.deviceId, pushToken: device.pushToken });
        return;
      }
      yield* devices.markDelivered({
        deviceId: device.deviceId,
        pushToken: device.pushToken,
        aggregate: delivery.acknowledge ? { value: delivery.deliveredAggregate } : null,
        threadPhases: delivery.threadPhases,
      });
    },
    Effect.catchTags({
      DirectPushDevicePersistenceError: (error) =>
        Effect.logWarning("direct push delivery skipped", { error: error.message }),
      DirectPushSessionCheckError: (error) =>
        Effect.logWarning("direct push delivery skipped", { error: error.message }),
      PlatformError: (error) =>
        Effect.logWarning("direct push delivery skipped", { error: error.message }),
    }),
  );

  const worker = yield* makeDrainableWorker(deliver);
  enqueue = worker.enqueue;

  let snapshotLoaded = false;
  // Only the newest delivery per device and thread matters: each one rebuilds
  // the card from current rows when it runs.
  const held = new Map<string, Map<ThreadId | null, DeliveryJob>>();
  const enqueueDelivery = (job: DeliveryJob) =>
    Effect.suspend(() => {
      if (snapshotLoaded) return worker.enqueue(job);
      const forDevice = held.get(job.deviceId) ?? new Map<ThreadId | null, DeliveryJob>();
      forDevice.set(job.threadId, job);
      held.set(job.deviceId, forDevice);
      return Effect.void;
    });

  const assertMayChange = Effect.fn("DirectPush.assertMayChange")(function* (input: {
    readonly deviceId: string;
    readonly sessionId: AuthSessionId;
    readonly pushToken?: string | undefined;
  }) {
    const existing = yield* devices.get(input.deviceId);
    if (Option.isNone(existing)) return;
    const row = existing.value;
    if (row.sessionId === input.sessionId || row.pushToken === input.pushToken) return;
    if ((yield* activeSessionIds).has(row.sessionId)) {
      return yield* new DirectPushDeviceNotOwnedError();
    }
  });

  const enqueueForDevices = Effect.fn("DirectPush.enqueueForDevices")(
    function* (threadId: ThreadId, state: RelayAgentActivityState | null, queuedAt: number) {
      const registered = yield* devices.list;
      yield* Effect.forEach(
        registered,
        (device) =>
          enqueueDelivery({
            deviceId: device.deviceId,
            pushToken: device.pushToken,
            threadId,
            state,
            replay: false,
            queuedAt,
            attempt: 0,
          }),
        { discard: true },
      );
    },
    Effect.catchTags({
      DirectPushDevicePersistenceError: (error) =>
        Effect.logWarning("direct push publish could not list devices", { error: error.message }),
    }),
  );

  return DirectPush.of({
    enabled,
    registerDevice: Effect.fn("DirectPush.registerDevice")(function* (input) {
      if (!(yield* enabled)) return yield* new DirectPushUnavailableError();
      yield* assertMayChange(input);
      const now = yield* DateTime.now;
      yield* devices.upsert({
        deviceId: input.deviceId,
        pushToken: input.pushToken,
        packageName: input.packageName,
        sessionId: input.sessionId,
        preferences: input.preferences,
        updatedAt: DateTime.formatIso(now),
      });
      // Like the relay, every registration replays the current card: the app
      // registers on launch and foreground to repair pushes it missed.
      yield* enqueueDelivery({
        deviceId: input.deviceId,
        pushToken: input.pushToken,
        threadId: null,
        state: null,
        replay: true,
        queuedAt: now.epochMilliseconds,
        attempt: 0,
      });
    }),
    unregisterDevice: Effect.fn("DirectPush.unregisterDevice")(function* (input) {
      yield* assertMayChange(input);
      yield* devices.remove(input.deviceId);
    }),
    publish: Effect.fn("DirectPush.publish")(function* (input) {
      const previous = rows.get(input.threadId);
      if (input.state === null) {
        if (previous === undefined) return;
        rows.delete(input.threadId);
      } else {
        // A relay publish failure retries the whole thread publish; the
        // repeated state must not send the same card again.
        if (previous !== undefined && encodeState(previous) === encodeState(input.state)) return;
        rows.set(input.threadId, input.state);
      }
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      for (const [threadId, state] of rows) {
        if (isRetiredState(state, nowMs)) rows.delete(threadId);
      }
      yield* enqueueForDevices(input.threadId, input.state, nowMs);
    }),
    markSnapshotLoaded: Effect.suspend(() => {
      if (snapshotLoaded) return Effect.void;
      snapshotLoaded = true;
      // Thread deliveries go first: one for a transition made while the
      // server was down must compare against the phases saved before it, not
      // the ones a replay records from the current card.
      const jobs = [...held.values()]
        .flatMap((forDevice) => [...forDevice.values()])
        .sort((a, b) => Number(a.replay) - Number(b.replay));
      held.clear();
      return Effect.forEach(jobs, worker.enqueue, { discard: true });
    }),
    drain: worker.drain,
    start: Effect.fn("DirectPush.start")(function* () {
      // Revoking a client's access must also stop its phone's notifications.
      yield* Stream.runForEach(sessions.streamChanges, (change) =>
        change.type === "clientRemoved"
          ? devices.removeForSession(change.sessionId).pipe(
              Effect.catchTags({
                DirectPushDevicePersistenceError: (error) =>
                  Effect.logWarning("direct push could not drop a revoked client's devices", {
                    error: error.message,
                  }),
              }),
            )
          : Effect.void,
      ).pipe(Effect.forkScoped);
    }),
  });
});

export const layer = Layer.effect(DirectPush, make);

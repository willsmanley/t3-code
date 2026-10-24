import {
  type AuthSessionId,
  DIRECT_PUSH_NOTIFICATION_USER_ID,
  type DirectPushDeviceRegistrationInput,
  DirectPushUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import {
  RelayAgentActivityState,
  type RelayAgentActivityAggregateState,
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

interface DeliveryJob {
  readonly deviceId: string;
  readonly pushToken: string;
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
 */
export function resolveDirectPushDelivery(input: {
  readonly deviceId: string;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly states: ReadonlyArray<RelayAgentActivityState>;
  readonly jobState: RelayAgentActivityState | null;
  readonly replay: boolean;
  readonly nowMs: number;
}): {
  readonly data: Record<string, string>;
  readonly alertIdentity: string | null;
  readonly acknowledge: boolean;
  readonly deliveredAggregate: RelayAgentActivityAggregateState | null;
} | null {
  const { preferences, previousAggregate, jobState, nowMs } = input;
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
    const state = input.states.find((row) => row.threadId === jobState.threadId);
    const stateIsCurrent =
      state !== undefined &&
      state.phase === jobState.phase &&
      state.updatedAt === jobState.updatedAt;
    if (previousAggregate === null && !stateIsCurrent) return null;
    if (preferences.liveActivitiesEnabled && previousAggregate !== null && aggregate !== null) {
      alert = androidAlertForAggregate({
        previousAggregate,
        nextAggregate: aggregate,
        preferences,
        nowMs,
      });
    } else if (
      state !== undefined &&
      stateIsCurrent &&
      !isExpiredAgentActivityState(state, nowMs)
    ) {
      alert = androidAlertForState(state, preferences, nowMs);
    }
  }
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
    readonly registerDevice: (
      input: DirectPushDeviceRegistrationInput & { readonly sessionId: AuthSessionId },
    ) => Effect.Effect<
      void,
      DirectPushUnavailableError | DirectPushDevices.DirectPushDevicePersistenceError
    >;
    readonly unregisterDevice: (
      deviceId: string,
    ) => Effect.Effect<void, DirectPushDevices.DirectPushDevicePersistenceError>;
    /** Records a thread's activity and queues deliveries; never waits on Firebase. */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void>;
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
      const device = (yield* devices.list).find(
        (row) => row.deviceId === job.deviceId && row.pushToken === job.pushToken,
      );
      if (device === undefined) return;
      const delivery = resolveDirectPushDelivery({
        deviceId: device.deviceId,
        preferences: device.preferences,
        previousAggregate: device.lastAggregate,
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
      if (delivery.acknowledge) {
        yield* devices.markDelivered({
          deviceId: device.deviceId,
          pushToken: device.pushToken,
          aggregate: delivery.deliveredAggregate,
        });
      }
    },
    Effect.catchTags({
      DirectPushDevicePersistenceError: (error) =>
        Effect.logWarning("direct push delivery skipped", { error: error.message }),
      PlatformError: (error) =>
        Effect.logWarning("direct push delivery skipped", { error: error.message }),
    }),
  );

  const worker = yield* makeDrainableWorker(deliver);
  enqueue = worker.enqueue;

  const enqueueForDevices = Effect.fn("DirectPush.enqueueForDevices")(
    function* (state: RelayAgentActivityState | null, queuedAt: number) {
      const registered = yield* devices.list;
      yield* Effect.forEach(
        registered,
        (device) =>
          worker.enqueue({
            deviceId: device.deviceId,
            pushToken: device.pushToken,
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
      yield* worker.enqueue({
        deviceId: input.deviceId,
        pushToken: input.pushToken,
        state: null,
        replay: true,
        queuedAt: now.epochMilliseconds,
        attempt: 0,
      });
    }),
    unregisterDevice: Effect.fn("DirectPush.unregisterDevice")(function* (deviceId) {
      yield* devices.remove(deviceId);
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
      yield* enqueueForDevices(input.state, nowMs);
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

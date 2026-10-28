import { type LiveActivity } from "expo-widgets";
import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AppState, Platform } from "react-native";
import {
  DIRECT_PUSH_NOTIFICATION_USER_ID,
  type DirectPushDeviceRegistrationInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  type RelayDeviceRegistrationRequest,
  type RelayAgentActivitySnapshotResponse,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessDirectPushPendingUnregisters,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  saveAgentAwarenessDirectPushPendingUnregisters,
  saveAgentAwarenessRegistrationRecord,
  type DirectPushPendingUnregisters,
} from "../../persistence/imperative";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import {
  dismissEndedAgentLiveActivities,
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "./agentLiveActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import { usesAndroidDirectPush } from "./directPush";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";

const REMOTE_ACTIVITY_REGISTRATION_RETRY_MS = 15_000;

const AgentAwarenessOperation = Schema.Literals([
  "read-notification-permissions",
  "read-native-push-token",
  "read-device-registration-relay-token",
  "read-device-unregistration-relay-token",
  "read-live-activity-registration-relay-token",
  "load-device-registration-identifier",
  "load-device-registration-preferences",
  "load-device-unregistration-identifier",
  "read-live-activity-push-token",
  "load-live-activity-registration-identifier",
  "list-active-live-activities",
  "load-live-activity-prime-preferences",
  "prime-live-activity",
]);

export class AgentAwarenessOperationError extends Schema.TaggedError<AgentAwarenessOperationError>()(
  "AgentAwarenessOperationError",
  {
    operation: AgentAwarenessOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Agent awareness operation ${this.operation} failed.`;
  }
}

// ActivityKit returns new wrappers per id; serialize by id to prevent stale-token registration.
const activityPushTokenLocks = new Map<string, Semaphore.Semaphore>();
// Each accepted registration replays the relay aggregate, repairing drifted or orphaned activities.
const ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS = 60_000;
// Match the relay's STALE_AFTER_SECONDS so activities expire even if registration fails.
const LIVE_ACTIVITY_STALE_AFTER_MS = 10 * 60_000;
const liveActivityStaleDate = () => new Date(Date.now() + LIVE_ACTIVITY_STALE_AFTER_MS);
const registeredActivityPushTokens = new Map<string, number>();
let androidDeviceReplayedAt: number | null = null;
let pushTokenSubscription: { remove: () => void } | null = null;
let appStateSubscription: { remove: () => void } | null = null;

export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";
let registrationStatus: AgentAwarenessRegistrationStatus = "unknown";
const registrationStatusListeners = new Set<() => void>();

function setRegistrationStatus(next: AgentAwarenessRegistrationStatus): void {
  if (registrationStatus === next) {
    return;
  }
  registrationStatus = next;
  for (const listener of registrationStatusListeners) {
    listener();
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return registrationStatus;
}

export function subscribeAgentAwarenessRegistrationStatus(listener: () => void): () => void {
  registrationStatusListeners.add(listener);
  return () => {
    registrationStatusListeners.delete(listener);
  };
}
let activeLiveActivityRegistrationRetry: ReturnType<typeof setTimeout> | null = null;
let relayTokenProvider: (() => Promise<string | null>) | null = null;
let relayTokenProviderIdentity: string | null = null;
let deviceRegistrationGeneration = 0;
let activeDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  operation: Promise<void>;
} | null = null;
let pendingDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  readonly context: string;
} | null = null;

interface DeviceRegistrationInput {
  readonly observedPushToken?: string;
  /** The set of direct push servers changed; an in-flight registration may have missed one. */
  readonly directPushTargetsChanged?: true;
}

export interface AgentAwarenessDirectPushTarget {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /**
   * Resolves with the environments that accepted the request; never rejects.
   * A null registration unregisters, proving ownership with `pushToken`.
   */
  readonly send: (request: {
    readonly environmentIds: ReadonlyArray<EnvironmentId>;
    readonly deviceId: string;
    readonly registration: DirectPushDeviceRegistrationInput | null;
    readonly pushToken?: string;
  }) => Promise<ReadonlyArray<EnvironmentId>>;
}

let directPushTarget: AgentAwarenessDirectPushTarget | null = null;
// Each accepted registration replays the card, like the relay path, so an
// unchanged registration repeats at most once a minute.
const directPushRegistrations = new Map<
  EnvironmentId,
  { readonly signature: string; readonly at: number }
>();
// Being removed: registrations skip them even while their config lingers.
const forgottenDirectPushEnvironments = new Set<EnvironmentId>();
let lastDirectPushToken: string | null = null;

const loadDirectPushPendingUnregisters = (): Promise<DirectPushPendingUnregisters> =>
  loadAgentAwarenessDirectPushPendingUnregisters().catch(() => ({}));

async function updateDirectPushPendingUnregisters(
  update: (pending: DirectPushPendingUnregisters) => DirectPushPendingUnregisters,
): Promise<void> {
  const pending = await loadDirectPushPendingUnregisters();
  await saveAgentAwarenessDirectPushPendingUnregisters(update(pending)).catch((error: unknown) => {
    logRegistrationError("persist direct push pending unregister failed", error);
  });
}

function withoutEnvironment<T>(
  record: Readonly<Record<string, T>>,
  environmentId: EnvironmentId,
): Record<string, T> {
  const { [environmentId]: _removed, ...rest } = record;
  return rest;
}

interface RegisterDeviceInput extends DeviceRegistrationInput {
  readonly preferencesOverride?: Partial<Preferences>;
}

function mergeAgentAwarenessRegistrationPreferences(
  stored: Preferences,
  override: Partial<Preferences> | undefined,
): Preferences {
  return { ...stored, ...override };
}

function readRelayConfig(): { readonly url: string } | null {
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (!relayUrl) {
    return null;
  }

  return { url: relayUrl };
}

function canRegisterRemoteLiveActivities(): boolean {
  return Platform.OS === "ios";
}

function canRegisterPushNotifications(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

function shouldRegisterAgentAwarenessDeviceForProvider(
  previousIdentity: string | null,
  identity: string | undefined,
): boolean {
  return identity === undefined || identity !== previousIdentity;
}

export function setAgentAwarenessRelayTokenProvider(
  provider: (() => Promise<string | null>) | null,
  identity?: string,
): void {
  // This build's pushes come from its own servers, so signing in or out of
  // T3 Connect must neither register it with the relay nor clear its cards.
  if (usesAndroidDirectPush()) return;
  const isExistingIdentity =
    provider !== null &&
    !shouldRegisterAgentAwarenessDeviceForProvider(relayTokenProviderIdentity, identity);
  if (!isExistingIdentity) {
    // An unset JS identity may mean remount; native configure checks the persisted account on cold start.
    if (relayTokenProviderIdentity && identity !== relayTokenProviderIdentity) {
      clearAndroidAgentNotifications();
    }
    androidDeviceReplayedAt = null;
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
    registeredActivityPushTokens.clear();
  }
  relayTokenProvider = provider;
  relayTokenProviderIdentity = provider ? (identity ?? null) : null;
  if (!provider) {
    clearAndroidAgentNotifications();
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    if (activeLiveActivityRegistrationRetry) {
      clearTimeout(activeLiveActivityRegistrationRetry);
      activeLiveActivityRegistrationRetry = null;
    }
    // Signed-out activities would be orphaned because the relay can no longer update or end them.
    endLocalLiveActivities("live activity cleanup after cloud sign-out failed");
    setRegistrationStatus("unknown");
    void clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
      logRegistrationError("clear registration record on sign-out failed", error);
    });
    return;
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after cloud sign-in failed",
  );
  if (isExistingIdentity) {
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after cloud session refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
}

// Provider remounts retain a valid relay registration; teardown must preserve it and lock-screen activities.
export function releaseAgentAwarenessRelayTokenProvider(): void {
  if (usesAndroidDirectPush()) return;
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  androidDeviceReplayedAt = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
}

function iosMajorVersion(): number {
  const version = Platform.Version;
  if (typeof version === "number") {
    return Math.floor(version);
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 18;
}

const nativePushTokenRegistration = Effect.fn("remoteRegistration.nativePushTokenRegistration")(
  function* (observedPushToken?: string) {
    if (!canRegisterPushNotifications() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    if (!permissions.granted) {
      return { notificationsEnabled: false, pushToken: null };
    }
    if (observedPushToken) {
      return { notificationsEnabled: true, pushToken: observedPushToken };
    }
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-native-push-token",
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logRegistrationError("native push token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const pushToken =
      token?.type === Platform.OS && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    return { notificationsEnabled: pushToken !== null, pushToken };
  },
);

const relayToken = Effect.fn("remoteRegistration.relayToken")(function* (
  operation: "read-device-registration-relay-token" | "read-live-activity-registration-relay-token",
) {
  const provider = relayTokenProvider;
  if (!provider) {
    return null;
  }
  return yield* Effect.tryPromise({
    try: provider,
    catch: (cause) => new AgentAwarenessOperationError({ operation, cause }),
  });
});

function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.platform,
    body.iosMajorVersion,
    body.androidApiLevel,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

const registerDeviceWithRelay = Effect.fn("remoteRegistration.registerDeviceWithRelay")(function* (
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    setRegistrationStatus("unknown");
    return;
  }
  const token = yield* relayToken("read-device-registration-relay-token");
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  if (!token) {
    setRegistrationStatus("unknown");
    return;
  }

  const identity = relayTokenProviderIdentity ?? "";
  const persisted = yield* Effect.tryPromise({
    try: () => loadAgentAwarenessRegistrationRecord(),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => null));
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the record loaded — do not resurrect the cleared
    // record or report the previous account's registration as current.
    return;
  }
  const payload = body;
  const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
  // Android registration also silently replays the current card. Collapse
  // foreground bursts, but repair missed pushes on cold start or a return
  // after time away, just like re-registering an iOS activity token.
  const needsAndroidReplay =
    body.platform === "android" &&
    (androidDeviceReplayedAt === null ||
      Date.now() - androidDeviceReplayedAt >= ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS);
  if (
    persisted &&
    persisted.identity === identity &&
    persisted.signature === signature &&
    !needsAndroidReplay
  ) {
    setRegistrationStatus("registered");
    return;
  }

  const client = yield* ManagedRelay.ManagedRelayClient;
  yield* client.registerDevice({
    clerkToken: token,
    payload,
  });
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the request was in flight: the sign-out path already
    // reset the status and cleared the record for the next account, so a
    // stale success must not overwrite either.
    return;
  }
  if (body.platform === "android") androidDeviceReplayedAt = Date.now();
  setRegistrationStatus("registered");
  yield* Effect.promise(() =>
    saveAgentAwarenessRegistrationRecord({
      identity,
      signature,
    }).catch((error: unknown) => {
      logRegistrationError("persist registration record failed", error);
    }),
  );
});

const registerDeviceWithDirectPush = Effect.fn("remoteRegistration.registerDeviceWithDirectPush")(
  function* (body: RelayDeviceRegistrationRequest, expectedGeneration: number) {
    const target = directPushTarget;
    const connected =
      target?.environmentIds.filter(
        (environmentId) => !forgottenDirectPushEnvironments.has(environmentId),
      ) ?? [];
    if (!target || connected.length === 0) {
      setRegistrationStatus("unknown");
      return;
    }
    if (body.pushToken) lastDirectPushToken = body.pushToken;
    // A server that was unreachable when its environment was removed still
    // holds the old registration. Clear it first, so an old pairing's row
    // cannot outlive a new one; one that still refuses is left alone.
    const pending = yield* Effect.promise(loadDirectPushPendingUnregisters);
    const stillOwed = new Set<EnvironmentId>();
    for (const environmentId of connected) {
      const owed = pending[environmentId];
      if (!owed) continue;
      const accepted = yield* Effect.promise(() =>
        target.send({
          environmentIds: [environmentId],
          deviceId: owed.deviceId,
          registration: null,
          ...(owed.pushToken ? { pushToken: owed.pushToken } : {}),
        }),
      );
      if (expectedGeneration !== deviceRegistrationGeneration) return;
      if (!accepted.includes(environmentId)) {
        stillOwed.add(environmentId);
        continue;
      }
      directPushRegistrations.delete(environmentId);
      yield* Effect.promise(() =>
        updateDirectPushPendingUnregisters((current) => withoutEnvironment(current, environmentId)),
      );
    }
    const environmentIds = connected.filter((environmentId) => !stillOwed.has(environmentId));
    // Without permission or a token the phone can show nothing, so the
    // servers stop sending instead of keeping a dead registration.
    const registration =
      body.pushToken && body.bundleId && body.preferences.notificationsEnabled
        ? {
            deviceId: body.deviceId,
            pushToken: body.pushToken,
            packageName: body.bundleId,
            preferences: body.preferences,
          }
        : null;
    const signature = registration ? registrationSignature(body) : "unregistered";
    const now = Date.now();
    const due = environmentIds.filter((environmentId) => {
      const previous = directPushRegistrations.get(environmentId);
      return (
        previous?.signature !== signature ||
        (registration !== null && now - previous.at >= ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS)
      );
    });
    if (due.length > 0) {
      logRegistrationDebug("direct push device registration request started", {
        environmentCount: due.length,
        registered: registration !== null,
      });
      const accepted = yield* Effect.promise(() =>
        target.send({
          environmentIds: due,
          deviceId: body.deviceId,
          registration,
          ...(body.pushToken ? { pushToken: body.pushToken } : {}),
        }),
      );
      if (expectedGeneration !== deviceRegistrationGeneration) return;
      for (const environmentId of accepted) {
        directPushRegistrations.set(environmentId, { signature, at: now });
      }
    }
    if (registration === null) {
      setRegistrationStatus("unknown");
      return;
    }
    const registeredSomewhere = environmentIds.some(
      (environmentId) => directPushRegistrations.get(environmentId)?.signature === signature,
    );
    if (registeredSomewhere) {
      setRegistrationStatus("registered");
    } else if (registrationStatus !== "registered") {
      setRegistrationStatus("failed");
    }
  },
);

/**
 * Removing an environment deletes its credentials, after which this device
 * could never ask that server to stop sending. If this attempt fails, the
 * owed unregister is kept and sent before registering when the same
 * environment connects again.
 */
export async function forgetAgentAwarenessDirectPushEnvironment(
  environmentId: EnvironmentId,
): Promise<void> {
  if (!usesAndroidDirectPush()) return;
  forgottenDirectPushEnvironments.add(environmentId);
  const deviceId = await loadAgentAwarenessDeviceId().catch(() => null);
  if (!deviceId) return;
  const owed = { deviceId, ...(lastDirectPushToken ? { pushToken: lastDirectPushToken } : {}) };
  await updateDirectPushPendingUnregisters((current) => ({ ...current, [environmentId]: owed }));
  // A registration already sending could land after this unregister and add
  // the row back; the forgotten mark keeps later ones from including it.
  await activeDeviceRegistration?.operation;
  directPushRegistrations.delete(environmentId);
  const target = directPushTarget;
  if (!target) return;
  const accepted = await target.send({
    environmentIds: [environmentId],
    registration: null,
    ...owed,
  });
  if (accepted.includes(environmentId)) {
    await updateDirectPushPendingUnregisters((current) =>
      withoutEnvironment(current, environmentId),
    );
  }
}

export function setAgentAwarenessDirectPushTarget(
  target: AgentAwarenessDirectPushTarget | null,
): void {
  if (!usesAndroidDirectPush()) return;
  const previous = directPushTarget;
  directPushTarget = target;
  if (!target) return;
  // Gone from the connected set, so the removal finished; if the environment
  // is paired again later, its owed unregister runs before it registers.
  for (const environmentId of forgottenDirectPushEnvironments) {
    if (!target.environmentIds.includes(environmentId)) {
      forgottenDirectPushEnvironments.delete(environmentId);
    }
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  if (previous?.environmentIds.join("\n") === target.environmentIds.join("\n")) return;
  enqueueDeviceRegistration(
    { directPushTargetsChanged: true },
    "direct push device registration failed",
  );
}

const unregisterDeviceWithRelay = Effect.fn("remoteRegistration.unregisterDeviceWithRelay")(
  function* (input: {
    readonly deviceId: string;
    readonly tokenProvider: () => Promise<string | null>;
  }): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
    if (!readRelayConfig()) return;
    const token = yield* Effect.tryPromise({
      try: input.tokenProvider,
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-device-unregistration-relay-token",
          cause,
        }),
    });
    if (!token) {
      return;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.unregisterDevice({
      clerkToken: token,
      deviceId: input.deviceId,
    });
  },
);

function environmentPublishesAgentActivity(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .agentActivityPublishing !== false
  );
}

export function armAgentAwarenessLiveActivityForLocalWork(input: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
    return;
  }
  if (!environmentPublishesAgentActivity(input.environmentId)) {
    return;
  }
  void loadPreferences()
    .catch(() => null)
    .then((preferences) => {
      if (preferences?.liveActivitiesEnabled === false) {
        return;
      }
      armAgentAwarenessLiveActivityForLocalWorkNow(input);
    });
}

function armAgentAwarenessLiveActivityForLocalWorkNow(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  try {
    if (getAgentLiveActivities().length > 0) {
      return;
    }
    const nowIso = new Date(Date.now()).toISOString();
    const activity = startAgentLiveActivity(
      {
        title: "T3 Code",
        subtitle: "Agent work in progress",
        activeCount: 1,
        updatedAt: nowIso,
        activities: [
          {
            environmentId: "",
            threadId: "",
            projectTitle: input.projectTitle,
            threadTitle: input.threadTitle,
            modelTitle: "",
            phase: "starting",
            status: "Connecting",
            updatedAt: nowIso,
            deepLink: "/",
          },
        ],
      },
      liveActivityStaleDate(),
    );
    if (!activity) {
      return;
    }
    runRegistrationInBackground(
      registerLiveActivityPushToken({ activity }).pipe(Effect.asVoid),
      "live activity arming after local task start failed",
    );
  } catch (error) {
    logRegistrationError("live activity arming failed", error);
  }
}

const readAgentActivitySnapshot: () => Effect.Effect<
  RelayAgentActivitySnapshotResponse | null,
  never,
  ManagedRelay.ManagedRelayClient
> = Effect.fn("remoteRegistration.readAgentActivitySnapshot")(
  function* () {
    if (!readRelayConfig()) return null;
    const token = yield* relayToken("read-live-activity-registration-relay-token");
    if (!token) {
      return null;
    }
    const client = yield* ManagedRelay.ManagedRelayClient;
    return yield* client.getAgentActivitySnapshot({ clerkToken: token });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("agent activity snapshot read failed", error);
      return null;
    }),
  ),
);

const registerLiveActivityWithRelay = Effect.fn("remoteRegistration.registerLiveActivityWithRelay")(
  function* (
    body: RelayLiveActivityRegistrationRequest,
  ): Effect.fn.Return<boolean, unknown, ManagedRelay.ManagedRelayClient> {
    if (!readRelayConfig()) return false;
    const token = yield* relayToken("read-live-activity-registration-relay-token");
    if (!token) {
      return false;
    }

    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.registerLiveActivity({
      clerkToken: token,
      payload: body,
    });
    return true;
  },
);

function logRegistrationError(context: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn(`[agent-awareness] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    traceId: findErrorTraceId(error),
    error,
  });
}

function runRegistrationInBackground(
  operation: Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
  context: string,
): void {
  void (async () => {
    const result = await settleAsyncResult(() => runtime.runPromiseExit(operation));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      logRegistrationError(context, squashAtomCommandFailure(result));
    }
  })();
}

function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  const directPushTargetsChanged =
    next.directPushTargetsChanged ?? current.directPushTargetsChanged;
  return {
    ...(observedPushToken ? { observedPushToken } : {}),
    ...(directPushTargetsChanged ? { directPushTargetsChanged } : {}),
  };
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    (next.observedPushToken !== undefined &&
      next.observedPushToken !== current.observedPushToken) ||
    next.directPushTargetsChanged === true
  );
}

function startPendingDeviceRegistration(): void {
  if (activeDeviceRegistration || !pendingDeviceRegistration) {
    return;
  }

  const next = pendingDeviceRegistration;
  pendingDeviceRegistration = null;
  const generation = deviceRegistrationGeneration;
  if (registrationStatus !== "registered") {
    setRegistrationStatus("pending");
  }
  const registration = {
    input: next.input,
    operation: Promise.resolve(),
  };
  activeDeviceRegistration = registration;
  registration.operation = (async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(registerDevice(next.input, generation)),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      // Refresh failures leave the relay's accepted registration intact; preserve registered status.
      if (registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
    if (activeDeviceRegistration === registration) {
      activeDeviceRegistration = null;
    }
    startPendingDeviceRegistration();
  })();
}

function enqueueDeviceRegistration(input: DeviceRegistrationInput, context: string): void {
  if (
    activeDeviceRegistration &&
    !registrationAddsInformation(activeDeviceRegistration.input, input)
  ) {
    return;
  }

  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

const registerDevice = Effect.fn("remoteRegistration.registerDevice")(function* (
  input: RegisterDeviceInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterPushNotifications()) {
    return;
  }

  const [deviceId, storedPreferences] = yield* Effect.all([
    Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-identifier",
          cause,
        }),
    }),
    Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-preferences",
          cause,
        }),
    }),
  ]);
  const preferences = mergeAgentAwarenessRegistrationPreferences(
    storedPreferences,
    input.preferencesOverride,
  );
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  const directPush = usesAndroidDirectPush();
  if (directPush) {
    configureAndroidAgentNotifications(
      deviceId,
      DIRECT_PUSH_NOTIFICATION_USER_ID,
      preferences.liveActivitiesEnabled !== false,
    );
  } else if (relayTokenProvider && relayTokenProviderIdentity) {
    configureAndroidAgentNotifications(
      deviceId,
      relayTokenProviderIdentity,
      preferences.liveActivitiesEnabled !== false,
    );
  }
  const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
  const bundleId =
    Platform.OS === "android"
      ? Constants.expoConfig?.android?.package?.trim()
      : Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  const request = makeRelayDeviceRegistrationRequest({
    deviceId,
    label:
      Constants.deviceName?.trim() || (Platform.OS === "android" ? "Android device" : "iOS device"),
    ...(Platform.OS === "android"
      ? { platform: "android" as const, androidApiLevel: Number(Platform.Version) }
      : { platform: "ios" as const, iosMajorVersion: iosMajorVersion() }),
    appVersion: Constants.expoConfig?.version,
    ...(bundleId ? { bundleId } : {}),
    ...(Platform.OS === "ios"
      ? { apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) }
      : {}),
    ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
    notificationsEnabled: pushTokenRegistration.notificationsEnabled,
    preferences,
  });
  if (directPush) {
    yield* registerDeviceWithDirectPush(request, expectedGeneration);
    return;
  }
  yield* registerDeviceWithRelay(request, expectedGeneration);
});

function registerDeviceForCurrentUser(): Effect.Effect<
  void,
  unknown,
  ManagedRelay.ManagedRelayClient
> {
  return registerDevice(undefined);
}

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterPushNotifications()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (
      token.type === Platform.OS &&
      typeof token.data === "string" &&
      token.data.trim().length > 0
    ) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native push token rotation registration failed",
      );
    }
  });
}

function ensureAppStateListener(): void {
  if (appStateSubscription || !canRegisterPushNotifications()) {
    return;
  }

  appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      return;
    }
    enqueueDeviceRegistration({}, "device registration after app foreground failed");
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity reconciliation after app foreground failed",
    );
  });
}

// Binaries built before the native dismissEnded method throw here.
function dismissEndedLocalLiveActivities(): void {
  try {
    dismissEndedAgentLiveActivities();
  } catch (error) {
    logRegistrationError("ended live activity cleanup failed", error);
  }
}

function endLocalLiveActivities(context: string): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  dismissEndedLocalLiveActivities();
  try {
    for (const activity of getAgentLiveActivities()) {
      activity.end("immediate").catch((error: unknown) => {
        logRegistrationError(context, error);
      });
    }
  } catch (error) {
    logRegistrationError(context, error);
  }
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  ManagedRelay.ManagedRelayClient
> {
  return registerDeviceForCurrentUser().pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device registration refresh failed", error);
      }),
    ),
  );
}

export function updateAgentAwarenessRegistrationPreferences(
  preferencesOverride: Partial<Preferences>,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return registerDevice({ preferencesOverride }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device preference registration refresh failed", error);
      }),
    ),
  );
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
  relayTokenProvider = null;
  relayTokenProviderIdentity = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  androidDeviceReplayedAt = null;
  registrationStatusListeners.clear();
  registeredActivityPushTokens.clear();
  activityPushTokenLocks.clear();
  directPushTarget = null;
  directPushRegistrations.clear();
  forgottenDirectPushEnvironments.clear();
  lastDirectPushToken = null;
}

export const unregisterAgentAwarenessDeviceForCurrentUser: (
  tokenProvider: () => Promise<string | null>,
) => Effect.Effect<void, never, ManagedRelay.ManagedRelayClient> = Effect.fn(
  "remoteRegistration.unregisterAgentAwarenessDeviceForCurrentUser",
)(
  function* (tokenProvider: () => Promise<string | null>) {
    if (usesAndroidDirectPush()) return;
    const deviceId = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-unregistration-identifier",
          cause,
        }),
    });
    if (!deviceId) {
      return;
    }
    yield* unregisterDeviceWithRelay({ deviceId, tokenProvider });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("device unregistration failed", error);
    }),
  ),
);

export const registerLiveActivityPushToken = Effect.fn(
  "remoteRegistration.registerLiveActivityPushToken",
)(function* (input: {
  readonly activity: LiveActivity<AgentActivityProps>;
}): Effect.fn.Return<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterRemoteLiveActivities()) {
    return false;
  }

  const lock = observeLiveActivityPushTokens(input.activity);
  return yield* lock.withPermit(
    Effect.gen(function* () {
      const activityPushToken = yield* Effect.tryPromise({
        try: () => input.activity.getPushToken(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "read-live-activity-push-token",
            cause,
          }),
      });
      if (!activityPushToken) {
        return false;
      }

      return yield* registerLiveActivityPushTokenValue({ activityPushToken });
    }),
  );
});

// Observe every token replacement: the relay otherwise keeps pushing to the old token until APNs rejects it.
function observeLiveActivityPushTokens(
  activity: LiveActivity<AgentActivityProps>,
): Semaphore.Semaphore {
  const activityId = activity.getId();
  const existing = activityPushTokenLocks.get(activityId);
  if (existing) return existing;
  const lock = Semaphore.makeUnsafe(1);
  activityPushTokenLocks.set(activityId, lock);
  activity.addPushTokenListener((event) => {
    if (!event.pushToken) return;
    runRegistrationInBackground(
      lock.withPermit(registerLiveActivityPushTokenValue({ activityPushToken: event.pushToken })),
      "live activity token listener registration failed",
    );
  });
  return lock;
}

const registerLiveActivityPushTokenValue = Effect.fn(
  "remoteRegistration.registerLiveActivityPushTokenValue",
)(function* (input: {
  readonly activityPushToken: string;
}): Effect.fn.Return<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  const acceptedAt = registeredActivityPushTokens.get(input.activityPushToken);
  if (acceptedAt !== undefined && Date.now() - acceptedAt < ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS) {
    return true;
  }
  const deviceId = yield* Effect.tryPromise({
    try: () => loadOrCreateAgentAwarenessDeviceId(),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "load-live-activity-registration-identifier",
        cause,
      }),
  });
  const registered = yield* registerLiveActivityWithRelay({
    deviceId,
    activityPushToken: input.activityPushToken,
  });
  if (registered) {
    registeredActivityPushTokens.set(input.activityPushToken, Date.now());
  }
  return registered;
});

function scheduleActiveLiveActivityRegistrationRetry(): void {
  if (activeLiveActivityRegistrationRetry || !relayTokenProvider) {
    return;
  }

  activeLiveActivityRegistrationRetry = setTimeout(() => {
    activeLiveActivityRegistrationRetry = null;
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity token retry failed",
    );
  }, REMOTE_ACTIVITY_REGISTRATION_RETRY_MS);
}

const refreshActiveLiveActivityRemoteRegistration = Effect.fn(
  "remoteRegistration.refreshActiveLiveActivityRemoteRegistration",
)(function* (): Effect.fn.Return<void, never, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
    return;
  }

  dismissEndedLocalLiveActivities();
  let activities = yield* Effect.try({
    try: () => getAgentLiveActivities(),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "list-active-live-activities",
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("active live activity lookup failed", error);
        return [] as ReadonlyArray<LiveActivity<AgentActivityProps>>;
      }),
    ),
  );

  // The relay tracks exactly one card per device; if concurrent arming ever
  // produced extras, end them so only one keeps receiving updates.
  if (activities.length > 1) {
    for (const extra of activities.slice(1)) {
      extra.end("immediate").catch((error: unknown) => {
        logRegistrationError("duplicate live activity cleanup failed", error);
      });
    }
    activities = activities.slice(0, 1);
  }

  // Activities are only ever created here, in the foreground, where the
  // update token can be observed and registered immediately — the relay never
  // remote-starts one (background push-to-start wakes proved too unreliable
  // to hand the token over).
  if (activities.length === 0) {
    const preferences = yield* Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-live-activity-prime-preferences",
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (preferences?.liveActivitiesEnabled !== false) {
      const snapshot = yield* readAgentActivitySnapshot();
      // The snapshot request yields; an arm-on-send may have created the
      // card in the meantime. Re-check so two cards are never started.
      const armedMeanwhile = yield* Effect.try({
        try: () => getAgentLiveActivities(),
        catch: () => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>,
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>));
      if (armedMeanwhile.length > 0) {
        activities = [...armedMeanwhile];
      } else if (snapshot?.aggregate && snapshot.aggregate.activeCount > 0) {
        const aggregate = snapshot.aggregate;
        const primed = yield* Effect.try({
          try: () =>
            startAgentLiveActivity(
              {
                title: aggregate.title,
                subtitle: aggregate.subtitle,
                activeCount: aggregate.activeCount,
                updatedAt: aggregate.updatedAt,
                activities: aggregate.activities,
              },
              liveActivityStaleDate(),
            ),
          catch: (cause) =>
            new AgentAwarenessOperationError({
              operation: "prime-live-activity",
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logRegistrationError("live activity priming failed", error);
              return null;
            }),
          ),
        );
        if (primed) {
          activities = [primed];
        }
      }
    }
  }

  const registrationResults = yield* Effect.forEach(activities, (activity) =>
    registerLiveActivityPushToken({ activity }).pipe(
      Effect.map((registered) => !registered),
      Effect.catch((error) =>
        Effect.sync(() => {
          logRegistrationError("active live activity token registration failed", error);
          return true;
        }),
      ),
    ),
  );

  if (registrationResults.some(Boolean)) {
    scheduleActiveLiveActivityRegistrationRetry();
  }
});

import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { DIRECT_PUSH_NOTIFICATION_USER_ID, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Exit from "effect/Exit";
import * as Notifications from "expo-notifications";

import { configureAndroidAgentNotifications } from "./androidNotifications";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  type AgentAwarenessDirectPushTarget,
  forgetAgentAwarenessDirectPushEnvironment,
  getAgentAwarenessRegistrationStatus,
  setAgentAwarenessDirectPushTarget,
  setAgentAwarenessRelayTokenProvider,
} from "./remoteRegistration";

const backgroundRuntime = vi.hoisted(() => ({
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
}));
const appStateMock = vi.hoisted(() => ({ listeners: [] as Array<(state: string) => void> }));
const pendingUnregisters = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: vi.fn(() => true),
  configureAndroidAgentNotifications: vi.fn(),
  clearAndroidAgentNotifications: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: {
    deviceName: "Pixel",
    expoConfig: {
      version: "1.0.0",
      android: { package: "com.example.t3code" },
      extra: {
        relay: { url: "https://relay.example.test/" },
        androidDirectPush: { firebaseProjectId: "fork-project" },
      },
    },
  },
}));

vi.mock("expo-widgets", () => ({}));
vi.mock("./agentLiveActivity", () => ({
  dismissEndedAgentLiveActivities: vi.fn(),
  getAgentLiveActivities: vi.fn(() => []),
  startAgentLiveActivity: vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environmentServerConfigsAtom"),
}));

vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "android", data: "fcm-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return "android";
    },
    get Version() {
      return 36;
    },
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateMock.listeners.push(listener);
      return {
        remove: () => {
          appStateMock.listeners.splice(appStateMock.listeners.indexOf(listener), 1);
        },
      };
    },
  },
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (operation: unknown) =>
      new Promise((resolve) => {
        backgroundRuntime.pending.push({ operation, resolve });
      }),
  },
}));

vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({ liveActivitiesEnabled: true })),
  loadAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve(null)),
  saveAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve()),
  clearAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve()),
  loadAgentAwarenessDirectPushPendingUnregisters: vi.fn(() =>
    Promise.resolve(pendingUnregisters.current),
  ),
  saveAgentAwarenessDirectPushPendingUnregisters: vi.fn((pending: Record<string, unknown>) => {
    pendingUnregisters.current = pending;
    return Promise.resolve();
  }),
}));

const ENVIRONMENT_ID = "env-1" as EnvironmentId;

// Registration runs through the app runtime, which the direct path needs no
// services from, so each queued operation runs here once the previous settles.
const runQueuedRegistrations = Effect.fn("TestDirectPush.runQueuedRegistrations")(function* () {
  for (let idle = 0; idle < 3;) {
    yield* Effect.promise(() => Promise.resolve());
    const pending = backgroundRuntime.pending.shift();
    if (!pending) {
      idle++;
      continue;
    }
    idle = 0;
    const exit = yield* Effect.exit(pending.operation as Effect.Effect<unknown>);
    pending.resolve(exit);
  }
});

function permissions(granted: boolean) {
  return { granted } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;
}

function makeTarget(environmentIds: ReadonlyArray<EnvironmentId> = [ENVIRONMENT_ID]) {
  const send = vi.fn<AgentAwarenessDirectPushTarget["send"]>((request) =>
    Promise.resolve(request.environmentIds),
  );
  return { target: { environmentIds, send }, send };
}

const foreground = () => appStateMock.listeners.forEach((listener) => listener("active"));

describe("direct push registration", () => {
  beforeEach(() => {
    __resetAgentAwarenessRemoteRegistrationForTest();
    backgroundRuntime.pending.length = 0;
    appStateMock.listeners.length = 0;
    vi.stubGlobal("__DEV__", false);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("T3 Connect must not be contacted")));
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue(permissions(true));
    vi.mocked(configureAndroidAgentNotifications).mockClear();
    pendingUnregisters.current = {};
  });

  it.effect("registers the FCM token with direct push servers, not T3 Connect", () =>
    Effect.gen(function* () {
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token"), "user-a");
      expect(backgroundRuntime.pending).toHaveLength(0);

      const { target, send } = makeTarget();
      setAgentAwarenessDirectPushTarget(target);
      yield* runQueuedRegistrations();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toEqual({
        environmentIds: [ENVIRONMENT_ID],
        deviceId: "device-1",
        registration: {
          deviceId: "device-1",
          pushToken: "fcm-token",
          packageName: "com.example.t3code",
          preferences: expect.objectContaining({
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
          }),
        },
        pushToken: "fcm-token",
      });
      expect(configureAndroidAgentNotifications).toHaveBeenCalledWith(
        "device-1",
        DIRECT_PUSH_NOTIFICATION_USER_ID,
        true,
      );
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }),
  );

  it.effect("repeats an unchanged registration on foreground only after a minute", () =>
    Effect.gen(function* () {
      using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const { target, send } = makeTarget();
      setAgentAwarenessDirectPushTarget(target);
      yield* runQueuedRegistrations();

      foreground();
      yield* runQueuedRegistrations();
      expect(send).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_061_000);
      foreground();
      yield* runQueuedRegistrations();
      expect(send).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("unregisters once notification permission is gone", () =>
    Effect.gen(function* () {
      const { target, send } = makeTarget();
      setAgentAwarenessDirectPushTarget(target);
      yield* runQueuedRegistrations();

      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue(permissions(false));
      foreground();
      yield* runQueuedRegistrations();
      expect(send.mock.calls[1]![0]).toMatchObject({ registration: null });
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    }),
  );

  it.effect("registers a newly connected server and unregisters before forgetting one", () =>
    Effect.gen(function* () {
      setAgentAwarenessDirectPushTarget(makeTarget().target);
      yield* runQueuedRegistrations();

      const second = "env-2" as EnvironmentId;
      const both = makeTarget([ENVIRONMENT_ID, second]);
      setAgentAwarenessDirectPushTarget(both.target);
      yield* runQueuedRegistrations();
      expect(both.send.mock.calls[0]![0].environmentIds).toEqual([second]);

      yield* Effect.promise(() => forgetAgentAwarenessDirectPushEnvironment(second));
      expect(both.send).toHaveBeenLastCalledWith({
        environmentIds: [second],
        deviceId: "device-1",
        registration: null,
        pushToken: "fcm-token",
      });
    }),
  );

  it.effect("retries an unregister a removed environment still owes before registering again", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const server = { reachable: false };
      const send = vi.fn<AgentAwarenessDirectPushTarget["send"]>((request) => {
        calls.push(request.registration ? "register" : "unregister");
        return Promise.resolve(
          request.registration || server.reachable ? request.environmentIds : [],
        );
      });
      setAgentAwarenessDirectPushTarget({ environmentIds: [ENVIRONMENT_ID], send });
      yield* runQueuedRegistrations();
      yield* Effect.promise(() => forgetAgentAwarenessDirectPushEnvironment(ENVIRONMENT_ID));

      // Removed while its server was down, then paired again once it is back.
      setAgentAwarenessDirectPushTarget({ environmentIds: [], send });
      yield* runQueuedRegistrations();
      server.reachable = true;
      setAgentAwarenessDirectPushTarget({ environmentIds: [ENVIRONMENT_ID], send });
      yield* runQueuedRegistrations();

      expect(calls).toEqual(["register", "unregister", "unregister", "register"]);
      expect(pendingUnregisters.current).toEqual({});
    }),
  );

  it.effect("a registration in flight cannot re-add a forgotten environment", () =>
    Effect.gen(function* () {
      const serverRows = new Set<EnvironmentId>();
      const control = { release: () => {}, started: () => {} };
      const started = new Promise<void>((resolve) => {
        control.started = resolve;
      });
      const send = vi.fn<AgentAwarenessDirectPushTarget["send"]>((request) => {
        if (!request.registration) {
          for (const environmentId of request.environmentIds) serverRows.delete(environmentId);
          return Promise.resolve(request.environmentIds);
        }
        control.started();
        return new Promise((resolve) => {
          control.release = () => {
            for (const environmentId of request.environmentIds) serverRows.add(environmentId);
            resolve(request.environmentIds);
          };
        });
      });
      setAgentAwarenessDirectPushTarget({ environmentIds: [ENVIRONMENT_ID], send });
      const registering = yield* runQueuedRegistrations().pipe(Effect.forkChild);
      yield* Effect.promise(() => started);

      const forgetting = forgetAgentAwarenessDirectPushEnvironment(ENVIRONMENT_ID);
      // Nothing else is queued, so this only lets the removal run as far as it can.
      yield* runQueuedRegistrations();
      control.release();
      yield* Fiber.join(registering);
      yield* Effect.promise(() => forgetting);
      yield* runQueuedRegistrations();

      expect(serverRows.size).toBe(0);
      expect(send.mock.calls.filter(([request]) => request.registration !== null)).toHaveLength(1);
    }),
  );
});

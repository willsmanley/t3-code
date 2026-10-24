import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { androidDirectPushProjectId, resolveDirectPushEnvironmentIds } from "./directPush";

const platform = vi.hoisted(() => ({ os: "android" }));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: () => true,
}));

function config(androidDirectPush?: { readonly firebaseProjectId: string }) {
  return { environment: { capabilities: androidDirectPush ? { androidDirectPush } : {} } };
}

describe("androidDirectPushProjectId", () => {
  it("reads the build's Firebase project on Android only", () => {
    const extra = { androidDirectPush: { firebaseProjectId: " fork-project " } };
    platform.os = "android";
    expect(androidDirectPushProjectId(extra)).toBe("fork-project");
    expect(androidDirectPushProjectId({})).toBeNull();
    expect(androidDirectPushProjectId({ androidDirectPush: { firebaseProjectId: 1 } })).toBeNull();
    platform.os = "ios";
    expect(androidDirectPushProjectId(extra)).toBeNull();
    platform.os = "android";
  });
});

describe("resolveDirectPushEnvironmentIds", () => {
  it("selects servers that push through the app's own Firebase project", () => {
    const configs = new Map([
      ["env-b" as EnvironmentId, config({ firebaseProjectId: "fork-project" })],
      ["env-other" as EnvironmentId, config({ firebaseProjectId: "someone-else" })],
      ["env-relay" as EnvironmentId, config()],
      ["env-a" as EnvironmentId, config({ firebaseProjectId: "fork-project" })],
    ]);
    expect(resolveDirectPushEnvironmentIds(configs, "fork-project")).toEqual(["env-a", "env-b"]);
    expect(resolveDirectPushEnvironmentIds(configs, null)).toEqual([]);
  });
});

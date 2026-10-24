import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { supportsAndroidAgentNotifications } from "./androidNotifications";

/**
 * Set at build time when the app carries its own Firebase project. T3 Connect's
 * relay sends with T3's project and can never reach such a build, so its
 * Android pushes come only from servers that send through the same project.
 */
export function androidDirectPushProjectId(
  extra: Readonly<Record<string, unknown>> | undefined = Constants.expoConfig?.extra,
): string | null {
  if (Platform.OS !== "android") return null;
  const config = extra?.androidDirectPush;
  if (typeof config !== "object" || config === null || !("firebaseProjectId" in config)) {
    return null;
  }
  const projectId = config.firebaseProjectId;
  return typeof projectId === "string" && projectId.trim() ? projectId.trim() : null;
}

export function usesAndroidDirectPush(): boolean {
  return androidDirectPushProjectId() !== null && supportsAndroidAgentNotifications();
}

export function resolveDirectPushEnvironmentIds(
  configs: ReadonlyMap<
    EnvironmentId,
    {
      readonly environment: {
        readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "androidDirectPush">;
      };
    }
  >,
  firebaseProjectId: string | null,
): ReadonlyArray<EnvironmentId> {
  if (firebaseProjectId === null) return [];
  return [...configs]
    .filter(
      ([, config]) =>
        config.environment.capabilities.androidDirectPush?.firebaseProjectId === firebaseProjectId,
    )
    .map(([environmentId]) => environmentId)
    .sort();
}

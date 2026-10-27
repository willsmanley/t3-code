import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import type { NewTaskDraftRouteParams } from "../threads/thread-route-state";

// MainActivity rewrites Android's assist launch to this link; see plugins/withAndroidAssistant.cjs.
const ASSISTANT_LAUNCH_URL = /^t3code(?:-dev|-preview)?:\/\/assist\/?$/;

export function isAssistantLaunchUrl(url: string): boolean {
  return ASSISTANT_LAUNCH_URL.test(url);
}

/**
 * A new draft in the project at `projectRoot`, or null when no connected project lives there.
 * A fresh `requestId` gives each launch its own draft instead of reopening the last one.
 */
export function assistantDraftParams(
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">>,
  projectRoot: string | null,
  requestId: string,
): NewTaskDraftRouteParams | null {
  const project = projectRoot ? findProjectByPath(projects, projectRoot) : undefined;
  return project
    ? { requestId, environmentId: String(project.environmentId), projectId: String(project.id) }
    : null;
}

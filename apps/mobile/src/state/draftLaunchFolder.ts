// Fork (F20): the folder picked for a sent draft (from a folder's new-thread button), so the
// outbox's thread launch carries it and the server files the thread there instead of in its
// default folder. In memory only: after a restart the thread is filed once it shows up instead.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

const launchFolders = new Map<string, string | null>();
const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

export function rememberLaunchFolder(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  folder: string | null,
): void {
  launchFolders.set(keyOf(environmentId, threadId), folder);
}

/** Nothing when no folder was picked, so the server uses its default folder. */
export function draftLaunchFolder(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { readonly folder?: string | null } {
  const key = keyOf(environmentId, threadId);
  return launchFolders.has(key) ? { folder: launchFolders.get(key) ?? null } : {};
}

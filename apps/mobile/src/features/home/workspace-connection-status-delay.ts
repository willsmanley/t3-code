import type { WorkspaceState } from "../../state/workspaceModel";

const STATUS_SHOW_DELAY_MS = 800;
// With saved threads or messages on screen, catching up after a return to the app is routine and
// they update in place, so the status waits until it takes noticeably long.
export const CATCH_UP_SHOW_DELAY_MS = 4_000;

/** How long a connection status waits before it shows (fork, docs/fork/features.md F15). */
export function workspaceConnectionStatusShowDelayMs(state: WorkspaceState): number {
  return state.hasLoadedShellSnapshot &&
    state.networkStatus !== "offline" &&
    state.connectionError === null &&
    state.shellSnapshotError === null
    ? CATCH_UP_SHOW_DELAY_MS
    : STATUS_SHOW_DELAY_MS;
}

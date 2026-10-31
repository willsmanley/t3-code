import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import { workspaceConnectionStatusShowDelayMs } from "./workspace-connection-status-delay";

const catchingUp: WorkspaceState = {
  isLoadingConnections: false,
  hasConnections: true,
  hasReadyEnvironment: true,
  hasConnectingEnvironment: false,
  connectingEnvironments: [],
  connectionState: "connected",
  connectionError: null,
  networkStatus: "online",
  hasLoadedShellSnapshot: true,
  hasPendingShellSnapshot: true,
  hasSyncingConnectedEnvironment: true,
  shellSnapshotError: null,
};

describe("workspaceConnectionStatusShowDelayMs", () => {
  it("waits longer while the saved thread list is on screen", () => {
    expect(workspaceConnectionStatusShowDelayMs(catchingUp)).toBe(4_000);
    expect(
      workspaceConnectionStatusShowDelayMs({
        ...catchingUp,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectionState: "reconnecting",
      }),
    ).toBe(4_000);
  });

  it("shows sooner with nothing saved, offline, or after an error", () => {
    expect(
      workspaceConnectionStatusShowDelayMs({ ...catchingUp, hasLoadedShellSnapshot: false }),
    ).toBe(800);
    expect(workspaceConnectionStatusShowDelayMs({ ...catchingUp, networkStatus: "offline" })).toBe(
      800,
    );
    expect(
      workspaceConnectionStatusShowDelayMs({ ...catchingUp, connectionError: "Timed out" }),
    ).toBe(800);
    expect(
      workspaceConnectionStatusShowDelayMs({ ...catchingUp, shellSnapshotError: "Bad snapshot" }),
    ).toBe(800);
  });
});

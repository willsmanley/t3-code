// Fork (F21): the JS half of "Stay connected after leaving" (docs/fork/features.md). It runs the
// headless task the native module starts on leaving, and logs every return to the app.
import { File, Paths } from "expo-file-system";
import { useEffect } from "react";
import { AppRegistry, AppState, Platform } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { workspaceConnections, workspaceStateAtom } from "../../state/workspace";
import {
  appendReturn,
  beginReturn,
  coveredWholeAway,
  finishReturn,
  observeReturn,
  parseReturnLog,
  returnObservationDone,
  type ReturnEntry,
  type WorkspaceSample,
} from "./keepConnectedLogic";
import {
  keepConnectedAvailable,
  readKeepConnectedAway,
  readKeepConnectedMinutes,
} from "./keepConnectedNative";

/** The key `KeepConnected.kt` starts. */
const TASK_KEY = "T3ForkKeepConnected";
const TICK_MS = 10_000;
const RETURN_LOG_FILE = "keep-connected-returns.json";

/**
 * React Native runs JS timers in the background only while a headless task is active, and the
 * connection's probes, retries and debounces all wait on timers. The task does nothing itself: it
 * lasts until the next return, and native ends it sooner when the window runs out or on Stop.
 */
function untilNextReturn(): Promise<void> {
  return new Promise((resolve) => {
    // Waits for a change, not the current state: the task can start before JS hears it left.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      subscription.remove();
      resolve();
    });
  });
}

if (Platform.OS === "android") {
  AppRegistry.registerHeadlessTask(TASK_KEY, () => untilNextReturn);
}

function returnLogFile() {
  return new File(Paths.document, RETURN_LOG_FILE);
}

export function readReturnLog(): ReturnEntry[] {
  try {
    const file = returnLogFile();
    return file.exists ? parseReturnLog(file.textSync()) : [];
  } catch {
    return [];
  }
}

const returnLogListeners = new Set<() => void>();

/** Runs `listener` after each return is logged; returns the unsubscribe. */
export function subscribeReturnLog(listener: () => void): () => void {
  returnLogListeners.add(listener);
  return () => {
    returnLogListeners.delete(listener);
  };
}

function saveReturn(entry: ReturnEntry): void {
  try {
    const next = appendReturn(readReturnLog(), entry);
    const file = returnLogFile();
    if (!file.exists) file.create();
    file.writeSync(JSON.stringify(next));
  } catch {
    // The log is only for picking the window; losing an entry is fine.
  }
  for (const listener of returnLogListeners) listener();
}

function sampleWorkspace(): WorkspaceSample {
  const state = appAtomRegistry.get(workspaceStateAtom);
  const environments = appAtomRegistry.get(workspaceConnections.environmentsAtom);
  return {
    fresh: state.hasReadyEnvironment && !state.hasSyncingConnectedEnvironment,
    connectedIds: environments
      .filter((environment) => environment.isEnabled && environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  };
}

/** Follows the thread list after a return until it is live and settled, then reports. */
function watchReturn(
  returnedAtMs: number,
  done: (result: ReturnType<typeof finishReturn>) => void,
): () => void {
  let observation = beginReturn(sampleWorkspace(), returnedAtMs);
  let finished = false;
  const unsubscribers: Array<() => void> = [];
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    done(finishReturn(observation));
  };
  const update = () => {
    const now = Date.now();
    observation = observeReturn(observation, sampleWorkspace(), now);
    if (returnObservationDone(observation, now)) finish();
  };
  unsubscribers.push(
    appAtomRegistry.subscribe(workspaceStateAtom, update),
    appAtomRegistry.subscribe(workspaceConnections.environmentsAtom, update),
  );
  // Ends the watch when nothing changes.
  const check = setInterval(update, 500);
  unsubscribers.push(() => clearInterval(check));
  return finish;
}

function startKeepConnectedTracking(): () => void {
  if (Platform.OS !== "android" || !keepConnectedAvailable()) return () => {};
  let backgroundedAtMs: number | null = null;
  let ticks = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let stopWatching: (() => void) | null = null;
  const stopTicker = () => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };

  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "background") {
      // Leaving again before the last return settled reports what it saw so far.
      stopWatching?.();
      if (backgroundedAtMs !== null) return;
      backgroundedAtMs = Date.now();
      ticks = 0;
      ticker = setInterval(() => {
        ticks += 1;
      }, TICK_MS);
      return;
    }
    if (state !== "active" || backgroundedAtMs === null) return;
    stopTicker();
    const returnedAtMs = Date.now();
    const away = readKeepConnectedAway();
    const entry = {
      at: returnedAtMs,
      awayMs: returnedAtMs - backgroundedAtMs,
      minutes: away?.minutes ?? readKeepConnectedMinutes(),
      covered: coveredWholeAway(away, backgroundedAtMs),
      ticks,
    };
    backgroundedAtMs = null;
    stopWatching = watchReturn(returnedAtMs, (result) => {
      stopWatching = null;
      saveReturn({ ...entry, ...result });
    });
  });
  return () => {
    subscription.remove();
    stopTicker();
    stopWatching?.();
  };
}

/** Mounted once in the root stack (fork F21). Android only; does nothing elsewhere. */
export function useKeepConnectedTracking(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to AppState for the app's lifetime to log each return
  useEffect(() => startKeepConnectedTracking(), []);
}

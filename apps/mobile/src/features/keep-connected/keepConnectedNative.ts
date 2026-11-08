// Fork (F21): the Android module in modules/t3-fork-keep-connected. It owns the setting (kept in
// SharedPreferences, because it is read natively the moment the app leaves, before JS could answer).
import { requireOptionalNativeModule } from "expo";

import type { MobileApplicationActiveWakeup } from "../../connection/app-state-wakeups";
import {
  DEFAULT_KEEP_CONNECTED_MINUTES,
  keepConnectedWakeup,
  type KeepConnectedAwayReport,
} from "./keepConnectedLogic";

type KeepConnectedModule = {
  readonly getMinutes: () => number;
  readonly setMinutes: (minutes: number) => number;
  readonly lastAway: () => KeepConnectedAwayReport | null;
};

const native = requireOptionalNativeModule<KeepConnectedModule>("T3ForkKeepConnected");

/** False on iOS and in builds without the module. */
export function keepConnectedAvailable(): boolean {
  return native !== null;
}

export function readKeepConnectedMinutes(): number {
  return native?.getMinutes() ?? DEFAULT_KEEP_CONNECTED_MINUTES;
}

/** Saves the setting natively; returns what was saved. */
export function writeKeepConnectedMinutes(minutes: number): number {
  return native?.setMinutes(minutes) ?? DEFAULT_KEEP_CONNECTED_MINUTES;
}

export function readKeepConnectedAway(): KeepConnectedAwayReport | null {
  return native?.lastAway() ?? null;
}

/** The hook in connection/platform.ts: a covered return only probes its live socket. */
export function forkKeepConnectedWakeup(
  wakeup: MobileApplicationActiveWakeup,
  backgroundedAtMs: number | null,
): MobileApplicationActiveWakeup {
  return native === null
    ? wakeup
    : keepConnectedWakeup(wakeup, backgroundedAtMs, readKeepConnectedAway());
}

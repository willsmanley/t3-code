// Fork (F21): pure parts of "Stay connected after leaving" (docs/fork/features.md). No React
// Native imports, so the unit tests run in Node.
import * as Schema from "effect/Schema";

import type { MobileApplicationActiveWakeup } from "../../connection/app-state-wakeups";

export const KEEP_CONNECTED_MINUTES = [0, 1, 5, 10, 15] as const;
export const DEFAULT_KEEP_CONNECTED_MINUTES = 5;

/** What the native module knows about the latest time away. */
export interface KeepConnectedAwayReport {
  readonly leftAtMs: number;
  readonly minutes: number;
  readonly started: boolean;
  readonly endReason: "off" | "failed" | "returned" | "expired" | "stopped" | "system" | null;
  readonly endedAtMs: number | null;
  readonly coveredWholeTime: boolean;
}

// AppState and the native lifecycle hook both read the wall clock on leaving, milliseconds apart.
const SAME_AWAY_TOLERANCE_MS = 5_000;

/** True when the service kept the app running and connected for this whole time away. */
export function coveredWholeAway(
  report: KeepConnectedAwayReport | null,
  backgroundedAtMs: number | null,
): boolean {
  return (
    report !== null &&
    backgroundedAtMs !== null &&
    report.coveredWholeTime &&
    Math.abs(report.leftAtMs - backgroundedAtMs) <= SAME_AWAY_TOLERANCE_MS
  );
}

/**
 * A covered return kept its socket live and its JS running, so it only needs the quick probe,
 * not the long-suspension handling that treats the socket as suspect.
 */
export function keepConnectedWakeup(
  wakeup: MobileApplicationActiveWakeup,
  backgroundedAtMs: number | null,
  report: KeepConnectedAwayReport | null,
): MobileApplicationActiveWakeup {
  return coveredWholeAway(report, backgroundedAtMs) ? "application-active-probe" : wakeup;
}

export const RETURN_LOG_LIMIT = 300;

const ReturnEntry = Schema.Struct({
  /** When the app came back (ms since epoch). */
  at: Schema.Number,
  awayMs: Schema.Number,
  /** The setting at the time; 0 is Off. */
  minutes: Schema.Number,
  /** The service kept the app running and connected the whole time away. */
  covered: Schema.Boolean,
  /** Every environment that was connected on return stayed connected (no reconnect). */
  socketAlive: Schema.Boolean,
  /** Ms until the thread list was live again: 0 if it never fell behind, null if it never got there. */
  freshMs: Schema.NullOr(Schema.Number),
  /** 10-second JS timer ticks seen while away: shows whether JS kept running. */
  ticks: Schema.Number,
});
export type ReturnEntry = typeof ReturnEntry.Type;
const isReturnEntry = Schema.is(ReturnEntry);

export function parseReturnLog(text: string | null): ReturnEntry[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isReturnEntry) : [];
}

export function appendReturn(
  log: ReadonlyArray<ReturnEntry>,
  entry: ReturnEntry,
  limit: number = RETURN_LOG_LIMIT,
): ReturnEntry[] {
  return [...log, entry].slice(-limit);
}

/** What the tracker reads from the workspace on each change. */
export interface WorkspaceSample {
  /** A connected environment's thread list is live ("Syncing threads..." would not show). */
  readonly fresh: boolean;
  /** Ids of the enabled environments whose connection is up. */
  readonly connectedIds: ReadonlyArray<string>;
}

export interface ReturnObservation {
  readonly returnedAtMs: number;
  /** Environments that were connected when the app came back. */
  readonly connectedOnReturn: ReadonlyArray<string>;
  readonly socketDropped: boolean;
  readonly sawStale: boolean;
  readonly fresh: boolean;
  /** When the list last became live, or null while it isn't. */
  readonly freshSinceMs: number | null;
}

export function beginReturn(sample: WorkspaceSample, nowMs: number): ReturnObservation {
  return {
    returnedAtMs: nowMs,
    connectedOnReturn: sample.connectedIds,
    socketDropped: sample.connectedIds.length === 0,
    sawStale: !sample.fresh,
    fresh: sample.fresh,
    freshSinceMs: sample.fresh ? nowMs : null,
  };
}

export function observeReturn(
  observation: ReturnObservation,
  sample: WorkspaceSample,
  nowMs: number,
): ReturnObservation {
  const dropped =
    observation.socketDropped ||
    observation.connectedOnReturn.some((id) => !sample.connectedIds.includes(id));
  return {
    ...observation,
    socketDropped: dropped,
    sawStale: observation.sawStale || !sample.fresh,
    fresh: sample.fresh,
    freshSinceMs: sample.fresh ? (observation.fresh ? observation.freshSinceMs : nowMs) : null,
  };
}

/** A probe answers within 3 seconds on a quick route; this also covers a resubscribe. */
export const RETURN_OBSERVE_MS = 10_000;
/** A list still catching up is followed this long before it counts as never caught up. */
export const RETURN_OBSERVE_MAX_MS = 60_000;

export function returnObservationDone(observation: ReturnObservation, nowMs: number): boolean {
  const elapsed = nowMs - observation.returnedAtMs;
  return elapsed >= RETURN_OBSERVE_MAX_MS || (elapsed >= RETURN_OBSERVE_MS && observation.fresh);
}

export function finishReturn(observation: ReturnObservation): {
  readonly socketAlive: boolean;
  readonly freshMs: number | null;
} {
  const freshMs = !observation.sawStale
    ? 0
    : observation.freshSinceMs === null
      ? null
      : observation.freshSinceMs - observation.returnedAtMs;
  return { socketAlive: !observation.socketDropped, freshMs };
}

export const FAST_RETURN_MS = 1_000;
const SUMMARY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReturnSummary {
  readonly days: number;
  readonly count: number;
  /** Share of returns within each setting's minutes (Off left out). */
  readonly withinMinutes: ReadonlyArray<{ readonly minutes: number; readonly share: number }>;
  readonly keptCount: number;
  readonly otherCount: number;
  /** Share up to date in under a second, for returns the service covered and for the rest. */
  readonly keptFastShare: number | null;
  readonly otherFastShare: number | null;
}

function fastShare(entries: ReadonlyArray<ReturnEntry>): number | null {
  if (entries.length === 0) return null;
  const fast = entries.filter((entry) => entry.freshMs !== null && entry.freshMs < FAST_RETURN_MS);
  return fast.length / entries.length;
}

export function summarizeReturns(
  log: ReadonlyArray<ReturnEntry>,
  nowMs: number,
  days: number = SUMMARY_DAYS,
): ReturnSummary {
  const recent = log.filter((entry) => entry.at > nowMs - days * DAY_MS && entry.at <= nowMs);
  const kept = recent.filter((entry) => entry.covered);
  const other = recent.filter((entry) => !entry.covered);
  return {
    days,
    count: recent.length,
    withinMinutes: KEEP_CONNECTED_MINUTES.filter((minutes) => minutes > 0).map((minutes) => ({
      minutes,
      share:
        recent.length === 0
          ? 0
          : recent.filter((entry) => entry.awayMs <= minutes * 60_000).length / recent.length,
    })),
    keptCount: kept.length,
    otherCount: other.length,
    keptFastShare: fastShare(kept),
    otherFastShare: fastShare(other),
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Two short lines for under the setting. */
export function formatReturnSummary(summary: ReturnSummary): string {
  if (summary.count === 0) return `No returns to the app logged in the last ${summary.days} days.`;
  const within = summary.withinMinutes
    .map(({ minutes, share }) => `${percent(share)} within ${minutes} min`)
    .join(", ");
  const returns = summary.count === 1 ? "1 return" : `${summary.count} returns`;
  const speed = [
    summary.keptFastShare === null
      ? null
      : `${percent(summary.keptFastShare)} of ${summary.keptCount} kept connected`,
    summary.otherFastShare === null
      ? null
      : `${percent(summary.otherFastShare)} of ${summary.otherCount} ${summary.otherCount === 1 ? "other" : "others"}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return `Last ${summary.days} days: ${returns}; ${within}.\nUp to date in under a second: ${speed}.`;
}

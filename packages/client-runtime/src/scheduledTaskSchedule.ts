// @effect-diagnostics globalDate:off -- Form defaults follow the local calendar, like the pickers that edit them.
import {
  isValidTimeZone,
  type ScheduledTask,
  type ScheduledTaskActiveHours,
} from "@t3tools/contracts";

/** Blank means the environment's local time; undefined means the text is not a known zone, which blocks saving. */
export function parseTimeZoneDraft(value: string): string | null | undefined {
  const zone = value.trim();
  if (zone === "") return null;
  // Intl matches names case-insensitively; store the canonical spelling.
  return isValidTimeZone(zone)
    ? Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
    : undefined;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Zones this client knows, starting with its own. */
export function timeZoneSuggestions(): ReadonlyArray<string> {
  const local = localTimeZone();
  const known =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [local, ...known.filter((zone) => zone !== local)];
}

export interface ActiveHoursDraft {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

export function activeHoursDraft(
  activeHours: ScheduledTaskActiveHours | undefined,
): ActiveHoursDraft {
  return activeHours === undefined
    ? { enabled: false, start: "09:00", end: "17:00", timeZone: "" }
    : { enabled: true, ...activeHours, timeZone: activeHours.timeZone ?? "" };
}

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const minuteOfDay = (value: string) => {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
};

/** Null when runs are not limited to a window; undefined when the window is not valid, which blocks saving. */
export function parseActiveHoursDraft(
  draft: ActiveHoursDraft,
): ScheduledTaskActiveHours | null | undefined {
  if (!draft.enabled) return null;
  const start = draft.start.trim();
  const end = draft.end.trim();
  const timeZone = parseTimeZoneDraft(draft.timeZone);
  if (
    timeZone === undefined ||
    !TIME_OF_DAY.test(start) ||
    !TIME_OF_DAY.test(end) ||
    minuteOfDay(start) === minuteOfDay(end)
  ) {
    return undefined;
  }
  return { start, end, ...(timeZone === null ? {} : { timeZone }) };
}

/**
 * Why a switched-off task stopped by itself, or null when it is still on or
 * someone paused it. A one-off "missed" its time when the server was down then.
 * A repeating task shows as ended once its run limit or end time is reached.
 */
export function scheduledTaskEnding(
  task: Pick<ScheduledTask, "enabled" | "schedule" | "lastRunAt" | "runCount">,
  now: number,
): "ran" | "missed" | "ended" | null {
  if (task.enabled) return null;
  const schedule = task.schedule;
  if (schedule.type === "once") {
    const at = Date.parse(schedule.at);
    if (task.lastRunAt !== null && Date.parse(task.lastRunAt) >= at) return "ran";
    return at <= now ? "missed" : null;
  }
  const limitReached =
    schedule.endAfterRuns !== undefined && task.runCount >= schedule.endAfterRuns;
  const endPassed = schedule.endAt !== undefined && Date.parse(schedule.endAt) <= now;
  return limitReached || endPassed ? "ended" : null;
}

/** Blank means no limit; undefined means the text is not a whole number of runs, which blocks saving. */
export function parseRunLimitDraft(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const runs = Number(value.trim());
  return Number.isSafeInteger(runs) && runs >= 1 ? runs : undefined;
}

/** A starting time for a new one-off: the first whole hour at least an hour away. */
export function defaultOneOffTime(now: number): Date {
  const next = new Date(now + 60 * 60_000);
  next.setMinutes(0, 0, 0);
  return next.getTime() - now < 60 * 60_000 ? new Date(next.getTime() + 60 * 60_000) : next;
}

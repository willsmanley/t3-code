import { isValidTimeZone, type ScheduledTaskActiveHours } from "@t3tools/contracts";

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

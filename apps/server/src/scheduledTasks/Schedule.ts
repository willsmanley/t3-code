import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ScheduledTaskActiveHours,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Without a zone, `from` keeps the environment's local zone it was read in. */
function inTimeZone(from: DateTime.DateTime, timeZone: string | undefined) {
  if (timeZone === undefined) return from;
  return Option.getOrNull(DateTime.setZoneNamed(from, timeZone));
}

/** Whether a wall-clock minute falls in [start, end), wrapping past midnight when end < start. */
function inWindow(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** `at` when it is inside the active hours, otherwise the next window start after it. */
function intoActiveHours(
  activeHours: ScheduledTaskActiveHours,
  at: DateTime.DateTime,
): DateTime.DateTime | null {
  const start = parseTimeOfDay(activeHours.start);
  const end = parseTimeOfDay(activeHours.end);
  if (start === null || end === null) return at;
  const zoned = inTimeZone(at, activeHours.timeZone);
  if (zoned === null) return null;
  const parts = DateTime.toParts(zoned);
  if (
    inWindow(
      parts.hour * 60 + parts.minute,
      start.hour * 60 + start.minute,
      end.hour * 60 + end.minute,
    )
  ) {
    return at;
  }
  for (let offset = 0; offset <= 1; offset += 1) {
    const windowStart = DateTime.setParts(DateTime.add(zoned, { days: offset }), {
      hour: start.hour,
      minute: start.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(windowStart) > DateTime.toEpochMillis(at)) return windowStart;
  }
  return null;
}

/**
 * The window start a due interval run waits for when it comes due outside its
 * active hours, as after the server was down; null when it may run now.
 */
export function activeHoursDeferral(
  schedule: ScheduledTaskSchedule,
  now: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type !== "interval" || schedule.activeHours === undefined) return null;
  const allowed = intoActiveHours(schedule.activeHours, now);
  return allowed !== null && DateTime.toEpochMillis(allowed) > DateTime.toEpochMillis(now)
    ? allowed
    : null;
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "once") {
    const at = DateTime.make(schedule.at);
    return Option.isSome(at) && DateTime.toEpochMillis(at.value) > DateTime.toEpochMillis(from)
      ? at.value
      : null;
  }
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    const next = DateTime.addDuration(
      from,
      Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS),
    );
    return schedule.activeHours === undefined ? next : intoActiveHours(schedule.activeHours, next);
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const zoned = inTimeZone(from, schedule.timeZone);
  if (zoned === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  // A wall-clock time skipped by a daylight-saving jump runs that much later;
  // a repeated one runs at its first occurrence only.
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(zoned, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

/**
 * An omitted optional field keeps its stored value, so a client that predates
 * the field can re-save a task without clearing it. Null clears it.
 */
function kept<A>(value: A | null | undefined, stored: A | undefined): A | undefined {
  return value === undefined ? stored : (value ?? undefined);
}

/** Stored in UTC so every reader sees the same instant in the same form. */
function utcInstant(value: string): string {
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

/** Ends carry over when a repeating task changes trigger type, as nothing else ties them to one. */
export function endsToStore(
  input: {
    readonly endAfterRuns?: number | null | undefined;
    readonly endAt?: string | null | undefined;
  },
  stored: ScheduledTaskSchedule | undefined,
): { readonly endAfterRuns?: number; readonly endAt?: string } {
  const storedEnds = stored === undefined || stored.type === "once" ? undefined : stored;
  const endAfterRuns = kept(input.endAfterRuns, storedEnds?.endAfterRuns);
  const endAt = kept(
    input.endAt == null ? input.endAt : utcInstant(input.endAt),
    storedEnds?.endAt,
  );
  return {
    ...(endAfterRuns === undefined ? {} : { endAfterRuns }),
    ...(endAt === undefined ? {} : { endAt }),
  };
}

export function timerScheduleToStore(
  input: Exclude<ScheduledTaskUpsertSchedule, { readonly type: "webhook" }>,
  stored: ScheduledTaskSchedule | undefined,
): ScheduledTaskSchedule {
  if (input.type === "once") return { type: "once", at: utcInstant(input.at) };
  if (input.type === "interval") {
    const activeHours = kept(
      input.activeHours,
      stored?.type === "interval" ? stored.activeHours : undefined,
    );
    return {
      type: "interval",
      everyMs: input.everyMs,
      ...(activeHours === undefined ? {} : { activeHours }),
      ...endsToStore(input, stored),
    };
  }
  const timeZone = kept(
    input.timeZone,
    stored?.type === "fixed_time" ? stored.timeZone : undefined,
  );
  return {
    type: "fixed_time",
    timeOfDay: input.timeOfDay,
    ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...endsToStore(input, stored),
  };
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

function activeHoursKey(activeHours: ScheduledTaskActiveHours | undefined): string {
  if (activeHours === undefined) return "always";
  const start = parseTimeOfDay(activeHours.start);
  const end = parseTimeOfDay(activeHours.end);
  return JSON.stringify([start, end, activeHours.timeZone ?? null]);
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return (
      b.type === "interval" &&
      a.everyMs === b.everyMs &&
      activeHoursKey(a.activeHours) === activeHoursKey(b.activeHours)
    );
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "once") return b.type === "once" && Date.parse(a.at) === Date.parse(b.at);
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
    a.timeZone === b.timeZone
  );
}

const MISSED_RUN_GRACE_MS = 10 * MINUTE_MS;

/** A fixed-time or one-off run this late, as after the server was down, is skipped; interval runs still run late. */
export function isMissedRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time" && schedule.type !== "once") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_RUN_GRACE_MS;
}

export type ScheduleEnd = "once" | "run_limit" | "end_time";

/**
 * Why a schedule has no run left, or null while it has: a one-off past its
 * time, a run limit reached, or no run before the end time. `next` is the run
 * the schedule would make next; webhooks have none and end when the time passes.
 */
export function scheduleEnd(
  schedule: ScheduledTaskSchedule,
  runCount: number,
  next: DateTime.DateTime | null,
  now: DateTime.DateTime,
): ScheduleEnd | null {
  if (schedule.type === "once") return next === null ? "once" : null;
  if (schedule.endAfterRuns !== undefined && runCount >= schedule.endAfterRuns) return "run_limit";
  const endAt =
    schedule.endAt === undefined ? null : Option.getOrNull(DateTime.make(schedule.endAt));
  if (endAt === null) return null;
  const last = schedule.type === "webhook" ? now : next;
  return last !== null && DateTime.toEpochMillis(last) > DateTime.toEpochMillis(endAt)
    ? "end_time"
    : null;
}

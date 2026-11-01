import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("checks a written time zone against Intl but reads any stored one", () => {
    const fixed = { type: "fixed_time", timeOfDay: "09:00" };
    expect(decodeUpsertSchedule({ ...fixed, timeZone: "America/Chicago" })).toEqual({
      ...fixed,
      timeZone: "America/Chicago",
    });
    expect(decodeUpsertSchedule({ ...fixed, timeZone: null })).toEqual({
      ...fixed,
      timeZone: null,
    });
    expect(() => decodeUpsertSchedule({ ...fixed, timeZone: "Mars/Olympus_Mons" })).toThrow();
    expect(decodeSchedule({ ...fixed, timeZone: "Mars/Olympus_Mons" })).toEqual({
      ...fixed,
      timeZone: "Mars/Olympus_Mons",
    });
  });

  it("takes stop conditions on repeating schedules only", () => {
    for (const schedule of [
      { type: "interval", everyMs: 60_000 },
      { type: "fixed_time", timeOfDay: "09:00" },
      { type: "webhook" },
    ]) {
      expect(
        decodeUpsertSchedule({ ...schedule, endAfterRuns: 3, endAt: "2026-10-23T14:00:00Z" }),
      ).toMatchObject({ endAfterRuns: 3, endAt: "2026-10-23T14:00:00Z" });
      expect(decodeUpsertSchedule({ ...schedule, endAfterRuns: null, endAt: null })).toMatchObject({
        endAfterRuns: null,
        endAt: null,
      });
      expect(() => decodeUpsertSchedule({ ...schedule, endAfterRuns: 0 })).toThrow();
      expect(() => decodeUpsertSchedule({ ...schedule, endAt: "2026-10-23T14:00" })).toThrow();
    }
    expect(
      decodeUpsertSchedule({ type: "once", runAt: "2026-10-23T14:00:00Z", endAfterRuns: 3 }),
    ).not.toHaveProperty("endAfterRuns");
  });

  it("accepts active hours that cross midnight but not an empty window", () => {
    const interval = { type: "interval", everyMs: 3_600_000 };
    const night = { start: "22:00", end: "06:00", timeZone: "America/Chicago" };
    expect(decodeUpsertSchedule({ ...interval, activeHours: night })).toEqual({
      ...interval,
      activeHours: night,
    });
    expect(() =>
      decodeUpsertSchedule({ ...interval, activeHours: { start: "9:00", end: "09:00" } }),
    ).toThrow();
    expect(() =>
      decodeUpsertSchedule({ ...interval, activeHours: { ...night, timeZone: "Nowhere" } }),
    ).toThrow();
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

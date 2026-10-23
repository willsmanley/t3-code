import { describe, expect, it } from "@effect/vitest";
import type { ScheduledTaskActiveHours, ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  activeHoursDeferral,
  endsToStore,
  isMissedRun,
  isSameSchedule,
  nextScheduledRunAt,
  scheduleEnd,
  timerScheduleToStore,
} from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  describe("fixed time in a time zone", () => {
    const next = (
      schedule: Partial<Extract<ScheduledTaskSchedule, { type: "fixed_time" }>>,
      from: string,
    ) => {
      const run = nextScheduledRunAt(
        { type: "fixed_time", timeOfDay: "09:00", timeZone: "America/Chicago", ...schedule },
        DateTime.makeUnsafe(from),
      );
      return run === null ? null : DateTime.formatIso(DateTime.toUtc(run));
    };

    it("runs at the wall-clock time of its zone, not the server's", () => {
      expect(next({}, "2026-07-03T10:00:00.000Z")).toBe("2026-07-03T14:00:00.000Z");
      expect(next({ timeZone: "Asia/Tokyo" }, "2026-07-03T10:00:00.000Z")).toBe(
        "2026-07-04T00:00:00.000Z",
      );
    });

    it("keeps the wall-clock time across the spring-forward change", () => {
      // 09:00 CST is 15:00Z; after clocks move forward on March 8, 09:00 CDT is 14:00Z.
      expect(next({}, "2026-03-07T16:00:00.000Z")).toBe("2026-03-08T14:00:00.000Z");
      // 02:30 does not exist on March 8, so that run moves to 03:30 CDT.
      expect(next({ timeOfDay: "02:30" }, "2026-03-08T07:00:00.000Z")).toBe(
        "2026-03-08T08:30:00.000Z",
      );
      expect(next({ timeOfDay: "02:30" }, "2026-03-08T08:31:00.000Z")).toBe(
        "2026-03-09T07:30:00.000Z",
      );
      // Lord Howe Island moves forward 30 minutes on October 4, so 02:15 runs at 02:45.
      expect(
        next({ timeOfDay: "02:15", timeZone: "Australia/Lord_Howe" }, "2026-10-03T14:00:00.000Z"),
      ).toBe("2026-10-03T15:45:00.000Z");
    });

    it("keeps the wall-clock time across the fall-back change and runs a repeated time once", () => {
      // 09:00 CDT is 14:00Z; after clocks move back on November 1, 09:00 CST is 15:00Z.
      expect(next({}, "2026-10-31T15:00:00.000Z")).toBe("2026-11-01T15:00:00.000Z");
      // 01:30 happens twice on November 1: first in CDT (06:30Z), then in CST (07:30Z).
      expect(next({ timeOfDay: "01:30" }, "2026-11-01T05:00:00.000Z")).toBe(
        "2026-11-01T06:30:00.000Z",
      );
      expect(next({ timeOfDay: "01:30" }, "2026-11-01T06:31:00.000Z")).toBe(
        "2026-11-02T07:30:00.000Z",
      );
    });

    it("applies weekdays in the zone's calendar", () => {
      // Friday 20:00 in Chicago is already Saturday in UTC.
      expect(next({ timeOfDay: "20:00", weekdays: [5] }, "2026-07-03T12:00:00.000Z")).toBe(
        "2026-07-04T01:00:00.000Z",
      );
    });

    it("has no next run for a zone this runtime does not know", () => {
      expect(next({ timeZone: "Mars/Olympus_Mons" }, "2026-07-03T10:00:00.000Z")).toBeNull();
    });
  });

  describe("interval active hours", () => {
    const hourly = (activeHours: ScheduledTaskActiveHours) =>
      ({ type: "interval", everyMs: 3_600_000, activeHours }) as const;
    const next = (schedule: ScheduledTaskSchedule, from: DateTime.DateTime | string) => {
      const run = nextScheduledRunAt(
        schedule,
        typeof from === "string" ? DateTime.makeUnsafe(from) : from,
      );
      return run === null ? null : DateTime.formatIso(DateTime.toUtc(run));
    };
    const office = hourly({ start: "09:00", end: "17:00", timeZone: "America/Chicago" });

    it("runs on the interval inside the window", () => {
      // 09:00 CDT is 14:00Z.
      expect(next(office, "2026-07-03T14:00:00.000Z")).toBe("2026-07-03T15:00:00.000Z");
    });

    it("moves a run that would land outside the window to the next window start", () => {
      // 16:30 + 1h is 17:30, past the window, so the run waits for 09:00 the next day.
      expect(next(office, "2026-07-03T21:30:00.000Z")).toBe("2026-07-04T14:00:00.000Z");
      // The end is not part of the window.
      expect(next(office, "2026-07-03T21:00:00.000Z")).toBe("2026-07-04T14:00:00.000Z");
      // 06:00 + 1h is before the window opens the same day.
      expect(next(office, "2026-07-03T11:00:00.000Z")).toBe("2026-07-03T14:00:00.000Z");
    });

    it("supports a window that crosses midnight", () => {
      const night = hourly({ start: "22:00", end: "06:00", timeZone: "America/Chicago" });
      // 04:30 + 1h = 05:30, still inside.
      expect(next(night, "2026-07-03T09:30:00.000Z")).toBe("2026-07-03T10:30:00.000Z");
      // 05:30 + 1h = 06:30, outside, so it waits for 22:00 that evening.
      expect(next(night, "2026-07-03T10:30:00.000Z")).toBe("2026-07-04T03:00:00.000Z");
      // 23:30 + 1h = 00:30 the next day, inside.
      expect(next(night, "2026-07-04T04:30:00.000Z")).toBe("2026-07-04T05:30:00.000Z");
    });

    it("uses the environment's zone when the window has none", () => {
      const tokyo = DateTime.makeZonedUnsafe(
        { year: 2026, month: 7, day: 3, hour: 16, minute: 30, second: 0, millisecond: 0 },
        { timeZone: "Asia/Tokyo", adjustForTimeZone: true },
      );
      // 17:30 Tokyo is outside 09:00–17:00, so the run moves to 09:00 Tokyo the next day.
      expect(next(hourly({ start: "09:00", end: "17:00" }), tokyo)).toBe(
        "2026-07-04T00:00:00.000Z",
      );
    });

    it("defers a due run only when it comes due outside the window", () => {
      const deferral = (schedule: ScheduledTaskSchedule, now: string) => {
        const at = activeHoursDeferral(schedule, DateTime.makeUnsafe(now));
        return at === null ? null : DateTime.formatIso(DateTime.toUtc(at));
      };
      expect(deferral(office, "2026-07-04T08:00:00.000Z")).toBe("2026-07-04T14:00:00.000Z");
      expect(deferral(office, "2026-07-04T15:00:00.000Z")).toBeNull();
      expect(
        deferral({ type: "interval", everyMs: 60_000 }, "2026-07-04T08:00:00.000Z"),
      ).toBeNull();
    });
  });

  describe("one-off", () => {
    const once = { type: "once", at: "2026-07-03T14:00:00.000Z" } as const;
    const at = (value: string) => DateTime.makeUnsafe(value);

    it("runs at its time and has no run after it", () => {
      const next = nextScheduledRunAt(once, at("2026-07-03T13:00:00.000Z"));
      expect(next && DateTime.formatIso(next)).toBe("2026-07-03T14:00:00.000Z");
      expect(nextScheduledRunAt(once, at("2026-07-03T14:00:00.000Z"))).toBeNull();
      expect(nextScheduledRunAt(once, at("2026-07-03T14:00:01.000Z"))).toBeNull();
    });

    it("is stored in UTC and compared as an instant", () => {
      const stored = timerScheduleToStore(
        { type: "once", at: "2026-07-03T09:00:00-05:00" },
        undefined,
      );
      expect(stored).toEqual(once);
      expect(isSameSchedule(stored, { type: "once", at: "2026-07-03T16:00:00+02:00" })).toBe(true);
      expect(isSameSchedule(stored, { type: "once", at: "2026-07-03T14:01:00.000Z" })).toBe(false);
    });

    it("skips a run more than ten minutes late, like a fixed time", () => {
      const due = at(once.at);
      expect(isMissedRun(once, due, at("2026-07-03T14:10:00.000Z"))).toBe(false);
      expect(isMissedRun(once, due, at("2026-07-03T14:10:01.000Z"))).toBe(true);
      expect(
        isMissedRun({ type: "interval", everyMs: 60_000 }, due, at("2026-07-04T00:00:00.000Z")),
      ).toBe(false);
    });
  });

  describe("stop conditions", () => {
    const at = (value: string) => DateTime.makeUnsafe(value);
    const now = at("2026-07-03T10:00:00.000Z");
    const endAt = "2026-07-03T12:00:00.000Z";

    it("ends a timer at its run limit or when its next run is after the end time", () => {
      const interval = { type: "interval", everyMs: 3_600_000, endAfterRuns: 3, endAt } as const;
      expect(scheduleEnd(interval, 2, at("2026-07-03T11:00:00.000Z"), now)).toBeNull();
      expect(scheduleEnd(interval, 3, at("2026-07-03T11:00:00.000Z"), now)).toBe("run_limit");
      expect(scheduleEnd(interval, 0, at(endAt), now)).toBeNull();
      expect(scheduleEnd(interval, 0, at("2026-07-03T12:00:01.000Z"), now)).toBe("end_time");
      const fixed = { type: "fixed_time", timeOfDay: "09:00", endAt } as const;
      expect(scheduleEnd(fixed, 9, at("2026-07-04T09:00:00.000Z"), now)).toBe("end_time");
      expect(scheduleEnd({ type: "fixed_time", timeOfDay: "09:00" }, 9, null, now)).toBeNull();
    });

    it("ends a webhook once the time passes, and a one-off once its time has gone", () => {
      const webhook = { type: "webhook", signature: null, endAt } as const;
      expect(scheduleEnd(webhook, 0, null, now)).toBeNull();
      expect(scheduleEnd(webhook, 0, null, at("2026-07-03T12:00:01.000Z"))).toBe("end_time");
      expect(scheduleEnd({ ...webhook, endAfterRuns: 1 }, 1, null, now)).toBe("run_limit");
      expect(scheduleEnd({ type: "once", at: endAt }, 0, null, now)).toBe("once");
    });

    it("stores ends in UTC and keeps omitted ones across trigger types", () => {
      const stored = timerScheduleToStore(
        { type: "interval", everyMs: 60_000, endAfterRuns: 2, endAt: "2026-07-03T07:00:00-05:00" },
        undefined,
      );
      expect(stored).toEqual({ type: "interval", everyMs: 60_000, endAfterRuns: 2, endAt });
      expect(endsToStore({}, stored)).toEqual({ endAfterRuns: 2, endAt });
      expect(endsToStore({ endAfterRuns: null }, stored)).toEqual({ endAt });
      expect(endsToStore({}, { type: "once", at: endAt })).toEqual({});
    });
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", timeZone: "America/Chicago" },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, activeHours: { start: "9:00", end: "17:00" } },
        { type: "interval", everyMs: 60_000, activeHours: { start: "09:00", end: "17:00" } },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, activeHours: { start: "09:00", end: "17:00" } },
        { type: "interval", everyMs: 60_000 },
      ),
    ).toBe(false);
  });
});

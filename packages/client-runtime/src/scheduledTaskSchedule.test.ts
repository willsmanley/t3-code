// @effect-diagnostics globalDate:off -- Builds local calendar times the way the form helpers read them.
import { describe, expect, it } from "vite-plus/test";

import {
  activeHoursDraft,
  defaultOneOffTime,
  parseActiveHoursDraft,
  parseRunLimitDraft,
  parseTimeZoneDraft,
  scheduledTaskEnding,
} from "./scheduledTaskSchedule.ts";

describe("parseTimeZoneDraft", () => {
  it("treats blank as the environment's zone, spells a known zone canonically, and rejects others", () => {
    expect(parseTimeZoneDraft("  ")).toBeNull();
    expect(parseTimeZoneDraft(" america/chicago ")).toBe("America/Chicago");
    expect(parseTimeZoneDraft("Chicago")).toBeUndefined();
  });
});

describe("parseActiveHoursDraft", () => {
  const draft = { enabled: true, start: "22:00", end: "06:00", timeZone: "", savedTimeZone: "" };

  it("accepts a window that crosses midnight and leaves the zone out when blank", () => {
    expect(parseActiveHoursDraft(draft)).toEqual({ start: "22:00", end: "06:00" });
    expect(parseActiveHoursDraft({ ...draft, enabled: false })).toBeNull();
  });

  it("rejects an empty window, a malformed time, or an unknown zone", () => {
    expect(parseActiveHoursDraft({ ...draft, end: "22:00" })).toBeUndefined();
    expect(parseActiveHoursDraft({ ...draft, start: "9:00", end: "09:00" })).toBeUndefined();
    expect(parseActiveHoursDraft({ ...draft, start: "24:00" })).toBeUndefined();
    expect(parseActiveHoursDraft({ ...draft, timeZone: "Chicago" })).toBeUndefined();
  });

  it("keeps a stored zone this client's time zone data lacks when other fields change", () => {
    const stored = activeHoursDraft({
      start: "22:00",
      end: "06:00",
      timeZone: "Mars/Olympus_Mons",
    });
    expect(parseActiveHoursDraft({ ...stored, start: "21:00" })).toEqual({
      start: "21:00",
      end: "06:00",
      timeZone: "Mars/Olympus_Mons",
    });
    expect(parseActiveHoursDraft({ ...stored, timeZone: "Mars/Tharsis" })).toBeUndefined();
  });
});

describe("scheduledTaskEnding", () => {
  const at = "2026-07-03T14:00:00.000Z";
  const once = {
    enabled: false,
    schedule: { type: "once", at },
    lastRunAt: null,
    runCount: 0,
  } as const;
  const before = Date.parse("2026-07-03T13:00:00.000Z");
  const after = Date.parse("2026-07-03T15:00:00.000Z");

  it("tells a one-off that ran from one that missed its time or was paused", () => {
    expect(scheduledTaskEnding({ ...once, lastRunAt: at }, after)).toBe("ran");
    expect(scheduledTaskEnding(once, after)).toBe("missed");
    expect(scheduledTaskEnding(once, before)).toBeNull();
    // A manual run before the set time does not count as the one-off's run.
    expect(scheduledTaskEnding({ ...once, lastRunAt: "2026-07-03T12:00:00.000Z" }, after)).toBe(
      "missed",
    );
    expect(scheduledTaskEnding({ ...once, enabled: true }, after)).toBeNull();
  });

  it("shows a repeating task as ended only once its limit or end time is reached", () => {
    const interval = {
      ...once,
      schedule: { type: "interval", everyMs: 60_000, endAfterRuns: 2, endAt: at },
    } as const;
    expect(scheduledTaskEnding({ ...interval, runCount: 2 }, before)).toBe("ended");
    expect(scheduledTaskEnding({ ...interval, runCount: 1 }, after)).toBe("ended");
    expect(scheduledTaskEnding({ ...interval, runCount: 1 }, before)).toBeNull();
  });
});

it("reads a run limit as blank for none or a whole number of runs", () => {
  expect(parseRunLimitDraft(" ")).toBeNull();
  expect(parseRunLimitDraft("3")).toBe(3);
  for (const invalid of ["0", "1.5", "-2", "lots"]) {
    expect(parseRunLimitDraft(invalid)).toBeUndefined();
  }
});

it("starts a new one-off on a whole hour at least an hour away", () => {
  const now = new Date(2026, 6, 3, 9, 20).getTime();
  expect(defaultOneOffTime(now)).toEqual(new Date(2026, 6, 3, 11, 0));
  expect(defaultOneOffTime(new Date(2026, 6, 3, 9, 0).getTime())).toEqual(
    new Date(2026, 6, 3, 10, 0),
  );
});

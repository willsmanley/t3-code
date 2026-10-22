// @effect-diagnostics globalDate:off -- Builds local calendar times the way the form helpers read them.
import { describe, expect, it } from "vite-plus/test";

import {
  defaultOneOffTime,
  parseActiveHoursDraft,
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
  const draft = { enabled: true, start: "22:00", end: "06:00", timeZone: "" };

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
});

describe("scheduledTaskEnding", () => {
  const at = "2026-07-03T14:00:00.000Z";
  const once = { enabled: false, schedule: { type: "once", at }, lastRunAt: null } as const;
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
});

it("starts a new one-off on a whole hour at least an hour away", () => {
  const now = new Date(2026, 6, 3, 9, 20).getTime();
  expect(defaultOneOffTime(now)).toEqual(new Date(2026, 6, 3, 11, 0));
  expect(defaultOneOffTime(new Date(2026, 6, 3, 9, 0).getTime())).toEqual(
    new Date(2026, 6, 3, 10, 0),
  );
});

import { describe, expect, it } from "vite-plus/test";

import { parseActiveHoursDraft, parseTimeZoneDraft } from "./scheduledTaskSchedule.ts";

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

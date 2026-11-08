import { describe, expect, it } from "vite-plus/test";

import {
  appendReturn,
  beginReturn,
  coveredWholeAway,
  finishReturn,
  formatReturnSummary,
  keepConnectedWakeup,
  observeReturn,
  parseReturnLog,
  returnObservationDone,
  summarizeReturns,
  type KeepConnectedAwayReport,
  type ReturnEntry,
} from "./keepConnectedLogic";

const report = (overrides: Partial<KeepConnectedAwayReport> = {}): KeepConnectedAwayReport => ({
  leftAtMs: 1_000_000,
  minutes: 5,
  started: true,
  endReason: "returned",
  endedAtMs: 1_100_000,
  coveredWholeTime: true,
  ...overrides,
});

const entry = (overrides: Partial<ReturnEntry> = {}): ReturnEntry => ({
  at: 10 * 86_400_000,
  awayMs: 30_000,
  minutes: 5,
  covered: true,
  socketAlive: true,
  freshMs: 0,
  ticks: 3,
  ...overrides,
});

describe("keepConnectedWakeup", () => {
  it("probes a return the service covered, even after a long time away", () => {
    expect(keepConnectedWakeup("application-active-long", 1_000_020, report())).toBe(
      "application-active-probe",
    );
  });

  it("keeps the usual classification when the app slept", () => {
    for (const endReason of ["expired", "stopped", "system", "off", "failed"] as const) {
      const slept = report({ endReason, coveredWholeTime: false });
      expect(keepConnectedWakeup("application-active-long", 1_000_000, slept)).toBe(
        "application-active-long",
      );
    }
    expect(keepConnectedWakeup("application-active-long", 1_000_000, null)).toBe(
      "application-active-long",
    );
  });

  it("ignores a report from another time away", () => {
    expect(coveredWholeAway(report(), 1_000_000 + 60_000)).toBe(false);
    expect(coveredWholeAway(report(), null)).toBe(false);
    expect(coveredWholeAway(report({ endReason: null }), 999_000)).toBe(true);
  });
});

describe("return log", () => {
  it("drops malformed files and entries", () => {
    expect(parseReturnLog(null)).toEqual([]);
    expect(parseReturnLog("{oops")).toEqual([]);
    expect(parseReturnLog(JSON.stringify({ at: 1 }))).toEqual([]);
    expect(parseReturnLog(JSON.stringify([entry(), { at: "x" }]))).toEqual([entry()]);
  });

  it("keeps only the newest entries", () => {
    const log = Array.from({ length: 5 }, (_, index) => entry({ at: index }));
    expect(appendReturn(log, entry({ at: 5 }), 3).map((item) => item.at)).toEqual([3, 4, 5]);
  });
});

describe("watching a return", () => {
  const live = { fresh: true, connectedIds: ["a"] };
  const syncing = { fresh: false, connectedIds: ["a"] };

  it("reports 0 ms and a live socket when the list never fell behind", () => {
    const observation = observeReturn(beginReturn(live, 0), live, 5_000);
    expect(returnObservationDone(observation, 9_999)).toBe(false);
    expect(returnObservationDone(observation, 10_000)).toBe(true);
    expect(finishReturn(observation)).toEqual({ socketAlive: true, freshMs: 0 });
  });

  it("measures until the list is live again after a resubscribe", () => {
    let observation = beginReturn(live, 1_000);
    observation = observeReturn(observation, syncing, 1_010);
    observation = observeReturn(observation, live, 1_240);
    observation = observeReturn(observation, live, 2_000);
    expect(finishReturn(observation)).toEqual({ socketAlive: true, freshMs: 240 });
  });

  it("notices a reconnect of an environment that was up on return", () => {
    let observation = beginReturn(live, 0);
    observation = observeReturn(observation, { fresh: false, connectedIds: [] }, 1_600);
    observation = observeReturn(observation, { fresh: true, connectedIds: ["a"] }, 3_900);
    expect(finishReturn(observation)).toEqual({ socketAlive: false, freshMs: 3_900 });
  });

  it("keeps watching a list that is still catching up, up to a minute", () => {
    const observation = beginReturn(syncing, 0);
    expect(returnObservationDone(observation, 30_000)).toBe(false);
    expect(returnObservationDone(observation, 60_000)).toBe(true);
    expect(finishReturn(observation)).toEqual({ socketAlive: true, freshMs: null });
    expect(finishReturn(beginReturn({ fresh: false, connectedIds: [] }, 0)).socketAlive).toBe(
      false,
    );
  });
});

describe("summarizeReturns", () => {
  const now = 10 * 86_400_000;

  it("summarizes the last 7 days for picking the window", () => {
    const log = [
      entry({ at: now - 8 * 86_400_000, awayMs: 10 }), // older than a week
      entry({ at: now - 1, awayMs: 20_000, freshMs: 0 }),
      entry({ at: now - 2, awayMs: 4 * 60_000, freshMs: 300 }),
      entry({ at: now - 3, awayMs: 9 * 60_000, covered: false, freshMs: 2_500 }),
      entry({ at: now - 4, awayMs: 3_600_000, covered: false, freshMs: null }),
    ];
    const summary = summarizeReturns(log, now);
    expect(summary.count).toBe(4);
    expect(summary.withinMinutes).toEqual([
      { minutes: 1, share: 0.25 },
      { minutes: 5, share: 0.5 },
      { minutes: 10, share: 0.75 },
      { minutes: 15, share: 0.75 },
    ]);
    expect(summary.keptFastShare).toBe(1);
    expect(summary.otherFastShare).toBe(0);
    expect(formatReturnSummary(summary)).toBe(
      "Last 7 days: 4 returns; 25% within 1 min, 50% within 5 min, 75% within 10 min, 75% within 15 min.\n" +
        "Up to date in under a second: 100% of 2 kept connected, 0% of 2 others.",
    );
  });

  it("says so when nothing is logged", () => {
    expect(formatReturnSummary(summarizeReturns([], now))).toBe(
      "No returns to the app logged in the last 7 days.",
    );
  });

  it("leaves out a group with no returns", () => {
    const summary = summarizeReturns([entry({ at: now, freshMs: 1_500 })], now);
    expect(formatReturnSummary(summary)).toBe(
      "Last 7 days: 1 return; 100% within 1 min, 100% within 5 min, 100% within 10 min, 100% within 15 min.\n" +
        "Up to date in under a second: 0% of 1 kept connected.",
    );
    const other = summarizeReturns([entry({ at: now, covered: false, freshMs: 200 })], now);
    expect(formatReturnSummary(other)).toContain("100% of 1 other.");
  });
});

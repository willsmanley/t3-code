import { describe, expect, it } from "vite-plus/test";

import {
  buildLegacyBulkSnoozeMenuItems,
  buildLegacySnoozeMenuItems,
  partitionLegacySnoozedThreads,
} from "./LegacySidebar.snooze.logic";

const NOW = "2026-10-24T12:00:00.000Z";

function thread(
  id: string,
  overrides: {
    environmentId?: string;
    snoozedUntil?: string | null;
    hasPendingApprovals?: boolean;
  } = {},
) {
  return {
    id,
    environmentId: overrides.environmentId ?? "env-a",
    snoozedUntil: overrides.snoozedUntil ?? null,
    snoozedAt: overrides.snoozedUntil ? "2026-10-24T11:00:00.000Z" : null,
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: false,
  };
}

const presets = [
  { id: "hour", label: "In 1 hour", whenLabel: "1:00 PM", snoozedUntil: "2026-10-24T13:00:00Z" },
] as const;

describe("partitionLegacySnoozedThreads", () => {
  it("parks future snoozes, soonest wake first, and keeps the rest in their tree", () => {
    const { awake, snoozed } = partitionLegacySnoozedThreads(
      [
        thread("late", { snoozedUntil: "2026-10-26T09:00:00.000Z" }),
        thread("plain"),
        thread("past", { snoozedUntil: "2026-10-24T11:59:00.000Z" }),
        thread("soon", { snoozedUntil: "2026-10-24T12:30:00.000Z" }),
      ],
      { now: NOW, supportsSnooze: () => true },
    );
    expect(awake.map((entry) => entry.id)).toEqual(["plain", "past"]);
    expect(snoozed.map((entry) => entry.id)).toEqual(["soon", "late"]);
  });

  it("returns a thread that raised its hand to its tree before the wake time", () => {
    const { awake, snoozed } = partitionLegacySnoozedThreads(
      [thread("asking", { snoozedUntil: "2026-10-25T09:00:00.000Z", hasPendingApprovals: true })],
      { now: NOW, supportsSnooze: () => true },
    );
    expect(awake.map((entry) => entry.id)).toEqual(["asking"]);
    expect(snoozed).toEqual([]);
  });

  it("leaves threads in place on servers without snooze", () => {
    const { awake, snoozed } = partitionLegacySnoozedThreads(
      [
        thread("old-server", {
          environmentId: "env-old",
          snoozedUntil: "2026-10-25T09:00:00.000Z",
        }),
        thread("new-server", { snoozedUntil: "2026-10-25T09:00:00.000Z" }),
      ],
      { now: NOW, supportsSnooze: (environmentId) => environmentId !== "env-old" },
    );
    expect(awake.map((entry) => entry.id)).toEqual(["old-server"]);
    expect(snoozed.map((entry) => entry.id)).toEqual(["new-server"]);
  });
});

describe("buildLegacySnoozeMenuItems", () => {
  const base = {
    canOperate: true,
    supportsSnooze: true,
    isSnoozed: false,
    canSnoozeNow: true,
    snoozePresets: presets,
  };

  it("offers the main sidebar's snooze presets and custom time", () => {
    const [item] = buildLegacySnoozeMenuItems(base);
    expect(item?.id).toBe("snooze");
    expect(item?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  it("offers wake for a snoozed thread and nothing on servers without snooze", () => {
    expect(buildLegacySnoozeMenuItems({ ...base, isSnoozed: true }).map((item) => item.id)).toEqual(
      ["unsnooze"],
    );
    expect(buildLegacySnoozeMenuItems({ ...base, supportsSnooze: false })).toEqual([]);
  });

  it("disables snooze without operate permission", () => {
    const [item] = buildLegacySnoozeMenuItems({ ...base, canOperate: false });
    expect(item?.disabled).toBe(true);
    expect(item?.children?.every((child) => child.disabled === true)).toBe(true);
  });
});

describe("buildLegacyBulkSnoozeMenuItems", () => {
  it("counts the selection and hides when any thread can't snooze", () => {
    const input = { count: 3, canOperate: true, canSnoozeSelection: true, snoozePresets: presets };
    expect(buildLegacyBulkSnoozeMenuItems(input)[0]?.label).toBe("Snooze (3)");
    expect(buildLegacyBulkSnoozeMenuItems({ ...input, canSnoozeSelection: false })).toEqual([]);
  });
});

import type { ContextMenuItem } from "@t3tools/contracts";
import {
  effectiveSnoozed,
  type SnoozePreset,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

import { buildThreadActionMenuItems, type ThreadActionMenuId } from "./threadActionMenu.logic";

export type LegacySnoozeMenuId = Extract<
  ThreadActionMenuId,
  "snooze" | `snooze:${string}` | "unsnooze"
>;

export function isLegacySnoozeMenuId(id: string | null): id is LegacySnoozeMenuId {
  return id === "snooze" || id === "unsnooze" || (id?.startsWith("snooze:") ?? false);
}

/**
 * Splits threads into those that stay in their project tree and those parked
 * in the Snoozed section, soonest wake first. Environments whose server can't
 * snooze keep every thread in its tree.
 */
export function partitionLegacySnoozedThreads<
  T extends ThreadSnoozeShell & { readonly environmentId: string },
>(
  threads: readonly T[],
  options: {
    readonly now: string;
    readonly supportsSnooze: (environmentId: T["environmentId"]) => boolean;
  },
): { readonly awake: T[]; readonly snoozed: T[] } {
  const awake: T[] = [];
  const snoozed: T[] = [];
  for (const thread of threads) {
    const parked =
      options.supportsSnooze(thread.environmentId) &&
      effectiveSnoozed(thread, { now: options.now });
    (parked ? snoozed : awake).push(thread);
  }
  // effectiveSnoozed only passes threads whose wake time parses.
  snoozed.sort(
    (left, right) => Date.parse(left.snoozedUntil ?? "") - Date.parse(right.snoozedUntil ?? ""),
  );
  return { awake, snoozed };
}

/** The Snooze or Wake entry of the main sidebar's thread menu, for the legacy menu. */
export function buildLegacySnoozeMenuItems(input: {
  readonly canOperate: boolean;
  readonly supportsSnooze: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}): ReadonlyArray<ContextMenuItem<LegacySnoozeMenuId>> {
  return buildThreadActionMenuItems({
    canOperate: input.canOperate,
    branch: null,
    projectFilter: null,
    isPinned: false,
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: input.isSnoozed,
    canSnoozeNow: input.canSnoozeNow,
    isRegeneratingTitle: false,
    isRunning: false,
    supports: {
      settlement: false,
      autoSettleOptOut: false,
      snooze: input.supportsSnooze,
      pinning: false,
      titleRegeneration: false,
    },
    snoozePresets: input.snoozePresets,
  }).filter((item): item is ContextMenuItem<LegacySnoozeMenuId> => isLegacySnoozeMenuId(item.id));
}

/** Snooze for a multi-thread selection, offered only when every thread can snooze now. */
export function buildLegacyBulkSnoozeMenuItems(input: {
  readonly count: number;
  readonly canOperate: boolean;
  readonly canSnoozeSelection: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}): ReadonlyArray<ContextMenuItem<LegacySnoozeMenuId>> {
  if (!input.canSnoozeSelection) return [];
  const disabled = !input.canOperate;
  return [
    {
      id: "snooze",
      label: `Snooze (${input.count})`,
      disabled,
      children: [
        ...input.snoozePresets.map((preset) => ({
          id: `snooze:${preset.id}` as const,
          label: `${preset.label} (${preset.whenLabel})`,
          disabled,
        })),
        { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true, disabled },
      ],
    },
  ];
}

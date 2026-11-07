import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import {
  ANDROID_NAVIGATION_TAB_ORDER,
  ANDROID_PHONE_NAVIGATION_TAB_CAPACITY,
  NAVIGATION_TAB_LABELS,
  NAVIGATION_TAB_ORDER,
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  enabledNavigationTabs,
  type NavigationTab,
} from "./navigation-tab-order";
import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { mobilePreferencesAtom } from "../../../state/preferences";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { resolveWorkspaceTabOrder } from "./workspace-tabs-state";

export const WORKSPACE_TAB_LABELS = {
  ...NAVIGATION_TAB_LABELS,
  ...(Platform.OS === "ios" ? { threads: "Chats", pullRequests: "PRs" } : {}),
};

export const NAVIGATION_TAB_ICONS = {
  threads: "text.bubble",
  workers: "calendar.badge.clock",
  pullRequests: PullRequestGlyph.pullRequest,
  usage: "chart.bar.xaxis",
} as const satisfies Readonly<Record<NavigationTab, AppSymbolName>>;

/** Fork (F18): only Android has the Workers tab; iOS keeps upstream's tabs. */
export const WORKERS_TAB_ENABLED = Platform.OS === "android";
export const DEFAULT_NAVIGATION_TAB_ORDER = WORKERS_TAB_ENABLED
  ? ANDROID_NAVIGATION_TAB_ORDER
  : NAVIGATION_TAB_ORDER;
const PLATFORM_HIDDEN_NAVIGATION_TABS: readonly NavigationTab[] = WORKERS_TAB_ENABLED
  ? []
  : ["workers"];
/** Sections on a phone's bar, before Settings; the rest open from the top of Settings. */
export const PHONE_NAVIGATION_TAB_CAPACITY = WORKERS_TAB_ENABLED
  ? ANDROID_PHONE_NAVIGATION_TAB_CAPACITY
  : 4;

export function workspaceTabOrder(saved: readonly unknown[] | undefined) {
  return resolveWorkspaceTabOrder(saved, DEFAULT_NAVIGATION_TAB_ORDER);
}

export function workspaceHiddenTabs(saved: readonly unknown[] | undefined) {
  return [
    ...(navigationCustomizationAvailable() ? resolveHiddenNavigationTabs(saved) : []),
    ...PLATFORM_HIDDEN_NAVIGATION_TABS,
  ];
}

export function useNavigationTabOrder() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.navigationTabOrder
    : undefined;
  return workspaceTabOrder(saved);
}

export function useHiddenNavigationTabs() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.hiddenNavigationTabs
    : undefined;
  return workspaceHiddenTabs(saved);
}

export function useEnabledNavigationTabs() {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  return enabledNavigationTabs(order, hidden);
}

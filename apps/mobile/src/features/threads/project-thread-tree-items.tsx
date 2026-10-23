import { memo } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { ThreadStatusDotKind } from "./projectThreadTree";

/**
 * The fork's Android build lists threads under project headers with status
 * dots, matching the desktop project tree. Other builds keep the flat list.
 */
export const PROJECT_THREAD_TREE_ENABLED = Platform.OS === "android";

const DOT_CLASS_NAME: Record<ThreadStatusDotKind, string> = {
  approval: "bg-warning-foreground",
  input: "bg-adaptive-indigo-600-300",
  failed: "bg-danger-foreground",
  limited: "bg-warning-foreground",
  woke: "bg-adaptive-amber-700-400",
  working: "bg-adaptive-sky-600-400",
  waiting: "bg-foreground-muted",
  done: "bg-adaptive-emerald-600-400",
};

const DOT_LABEL: Record<ThreadStatusDotKind, string> = {
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  limited: "Usage limit reached",
  woke: "Woke from snooze",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
};

export function ThreadStatusDot(props: { readonly kind: ThreadStatusDotKind }) {
  return (
    <View
      accessible
      accessibilityLabel={DOT_LABEL[props.kind]}
      className={cn("size-2 rounded-full", DOT_CLASS_NAME[props.kind])}
    />
  );
}

export const ProjectThreadTreeHeader = memo(function ProjectThreadTreeHeader(props: {
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly status: ThreadStatusDotKind | null;
  readonly disabled?: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: () => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.title}, ${props.threadCount} ${props.threadCount === 1 ? "thread" : "threads"}`}
      accessibilityHint={`${props.collapsed ? "Shows" : "Hides"} this project's threads.`}
      accessibilityState={{ disabled: props.disabled, expanded: !props.collapsed }}
      className={cn("mt-3 flex-row items-center gap-2 py-1.5", sidebarPane ? "px-3" : "px-5")}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="w-3 items-center">
        <SymbolView
          name={props.collapsed ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName={sidebarPane ? "accent-drawer-foreground-muted" : "accent-icon-muted"}
          type="monochrome"
        />
      </View>
      <Text
        className={cn(
          "min-w-0 flex-1 text-sm font-t3-medium",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {props.title}
      </Text>
      {props.collapsed && props.status !== null ? <ThreadStatusDot kind={props.status} /> : null}
      {props.collapsed ? (
        <Text className="text-xs tabular-nums text-foreground-muted">{props.threadCount}</Text>
      ) : null}
    </Pressable>
  );
});

export const ProjectThreadTreeMoreRow = memo(function ProjectThreadTreeMoreRow(props: {
  readonly hiddenCount: number;
  readonly expanded: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: () => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      className={cn("flex-row py-2", sidebarPane ? "pl-8 pr-3" : "pl-10 pr-5")}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
        )}
      >
        {props.expanded ? "Show less" : `Show ${props.hiddenCount} more`}
      </Text>
    </Pressable>
  );
});

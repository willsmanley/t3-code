import type { MenuAction } from "@react-native-menu/menu";
import { memo } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import type { ThreadStatusDotKind } from "./projectThreadTree";

/**
 * The fork's Android build lists threads under project headers with status
 * dots, matching the desktop project tree. Other builds keep the flat list.
 */
export const PROJECT_THREAD_TREE_ENABLED = Platform.OS === "android";

// Icons, not plain dots: a still colored dot reads as "unread", so a working
// thread looked finished. These match the flat list's status labels.
const STATUS_ICON: Record<
  ThreadStatusDotKind,
  { readonly name: AppSymbolName; readonly tint: string; readonly label: string }
> = {
  approval: {
    name: "exclamationmark.shield",
    tint: "accent-warning-foreground",
    label: "Needs approval",
  },
  input: {
    name: "questionmark.bubble",
    tint: "accent-adaptive-indigo-600-300",
    label: "Needs input",
  },
  failed: { name: "exclamationmark.circle", tint: "accent-danger-foreground", label: "Failed" },
  limited: {
    name: "exclamationmark.circle",
    tint: "accent-warning-foreground",
    label: "Usage limit reached",
  },
  woke: { name: "bell.badge", tint: "accent-adaptive-amber-700-400", label: "Woke from snooze" },
  working: { name: "circle.dashed", tint: "accent-adaptive-sky-600-400", label: "Working" },
  waiting: {
    name: "circle.dashed.inset.filled",
    tint: "accent-foreground-muted",
    label: "Waiting",
  },
  done: { name: "checkmark.circle", tint: "accent-adaptive-emerald-600-400", label: "Done" },
};

export function ThreadStatusIcon(props: { readonly kind: ThreadStatusDotKind }) {
  const icon = STATUS_ICON[props.kind];
  return (
    <View accessible accessibilityLabel={icon.label}>
      <SymbolView
        name={icon.name}
        size={12}
        tintColorClassName={icon.tint}
        type="monochrome"
        weight="semibold"
      />
    </View>
  );
}

export const ProjectThreadTreeHeader = memo(function ProjectThreadTreeHeader(props: {
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly status: ThreadStatusDotKind | null;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly disabled?: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: () => void;
  readonly onNewThread: () => void;
  readonly onMove: (direction: "up" | "down") => void;
  readonly onArrange: () => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  const iconTint = sidebarPane ? "accent-drawer-foreground-muted" : "accent-icon-muted";
  const menuActions: MenuAction[] = [
    { id: "arrange", title: "Arrange projects…", image: "line.3.horizontal" },
    {
      id: "move-up",
      title: "Move up",
      image: "arrow.up",
      attributes: { disabled: !props.canMoveUp },
    },
    {
      id: "move-down",
      title: "Move down",
      image: "arrow.down",
      attributes: { disabled: !props.canMoveDown },
    },
  ];
  return (
    <View className={cn("mt-3 flex-row items-center", sidebarPane ? "pr-1.5" : "pr-3")}>
      <Menu
        actions={menuActions}
        className="min-w-0 flex-1"
        onPressAction={({ nativeEvent }) => {
          if (props.disabled) return;
          if (nativeEvent.event === "arrange") props.onArrange();
          if (nativeEvent.event === "move-up" && props.canMoveUp) props.onMove("up");
          if (nativeEvent.event === "move-down" && props.canMoveDown) props.onMove("down");
        }}
        shouldOpenOnLongPress
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.title}, ${props.threadCount} ${props.threadCount === 1 ? "thread" : "threads"}`}
          accessibilityHint={`${props.collapsed ? "Shows" : "Hides"} this project's threads. Long press to reorder projects.`}
          accessibilityState={{ disabled: props.disabled, expanded: !props.collapsed }}
          accessibilityActions={[
            { name: "arrange", label: "Arrange projects" },
            ...(props.canMoveUp ? [{ name: "move-up", label: "Move up" }] : []),
            ...(props.canMoveDown ? [{ name: "move-down", label: "Move down" }] : []),
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (props.disabled) return;
            if (nativeEvent.actionName === "arrange") props.onArrange();
            if (nativeEvent.actionName === "move-up") props.onMove("up");
            if (nativeEvent.actionName === "move-down") props.onMove("down");
          }}
          className={cn(
            "min-w-0 flex-1 flex-row items-center gap-2 py-1.5",
            sidebarPane ? "pl-3" : "pl-5",
          )}
          disabled={props.disabled}
          onPress={props.onToggle}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <View className="w-3 items-center">
            <SymbolView
              name={props.collapsed ? "chevron.right" : "chevron.down"}
              size={12}
              tintColorClassName={iconTint}
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
          {props.collapsed && props.status !== null ? (
            <ThreadStatusIcon kind={props.status} />
          ) : null}
          {props.collapsed ? (
            <Text className="text-xs tabular-nums text-foreground-muted">{props.threadCount}</Text>
          ) : null}
        </Pressable>
      </Menu>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New thread in ${props.title}`}
        className="ml-1 p-2"
        hitSlop={6}
        onPress={props.onNewThread}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="square.and.pencil"
          size={16}
          tintColorClassName={iconTint}
          type="monochrome"
        />
      </Pressable>
    </View>
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

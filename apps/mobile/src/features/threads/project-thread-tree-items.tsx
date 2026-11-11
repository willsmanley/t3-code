import type { MenuAction } from "@react-native-menu/menu";
import { isAutoFiledThread } from "@t3tools/contracts";
import { memo } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import type { ThreadStatusDotKind } from "./projectThreadTree";

/**
 * The fork's Android build lists threads under folder headers (F20) with status
 * dots, matching the desktop sidebar. Other builds keep the flat list.
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
  request: {
    name: "person.crop.circle",
    tint: "accent-adaptive-fuchsia-600-300",
    label: "Guest request",
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

const FOLDER_HEADER_ACTIONS = [
  "rename",
  "default",
  "delete",
  "new-folder",
  "arrange",
  "move-up",
  "move-down",
  "folder-per-project",
  "auto-file",
] as const;
export type ThreadFolderHeaderAction = (typeof FOLDER_HEADER_ACTIONS)[number];

function isFolderHeaderAction(id: string): id is ThreadFolderHeaderAction {
  return (FOLDER_HEADER_ACTIONS as ReadonlyArray<string>).includes(id);
}

function TreeIconButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly tint: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      className="ml-1 p-2"
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView name={props.icon} size={16} tintColorClassName={props.tint} type="monochrome" />
    </Pressable>
  );
}

/** Fork (F20): a folder header in the thread tree; `folder` null is Unfiled. */
export const ThreadFolderHeader = memo(function ThreadFolderHeader(props: {
  readonly folder: string | null;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly status: ThreadStatusDotKind | null;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canArrange: boolean;
  readonly offerFolderPerProject: boolean;
  /** New threads started without a folder land here. */
  readonly isDefault?: boolean;
  /** The servers keep a default folder, so the menu can choose one. */
  readonly canSetDefault?: boolean;
  /** Unfiled's menu switches auto-filing; undefined hides the item. */
  readonly autoFile?: boolean;
  readonly disabled?: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: () => void;
  /** Leave out to hide the new-thread button. */
  readonly onNewThread?: () => void;
  readonly onAction: (action: ThreadFolderHeaderAction) => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  const iconTint = sidebarPane ? "accent-drawer-foreground-muted" : "accent-icon-muted";
  const unfiled = props.folder === null;
  const title = props.folder ?? "Unfiled";
  const menuActions: MenuAction[] = [
    ...(unfiled ? [] : [{ id: "rename", title: "Rename…", image: "pencil" } satisfies MenuAction]),
    ...(unfiled || props.canSetDefault !== true
      ? []
      : [
          {
            id: "default",
            title: props.isDefault ? "Stop sending new threads here" : "New threads go here",
            image: "tray.and.arrow.down",
          } satisfies MenuAction,
        ]),
    { id: "new-folder", title: "New folder…", image: "folder.badge.plus" },
    ...(unfiled && props.autoFile !== undefined
      ? [
          {
            id: "auto-file",
            title: "Auto-file new threads",
            image: "brain",
            state: props.autoFile ? "on" : "off",
          } satisfies MenuAction,
        ]
      : []),
    ...(props.offerFolderPerProject
      ? [
          {
            id: "folder-per-project",
            title: "Make a folder for each project",
            image: "folder",
          } satisfies MenuAction,
        ]
      : []),
    ...(props.canArrange
      ? [
          {
            id: "arrange",
            title: "Arrange folders…",
            image: "line.3.horizontal",
          } satisfies MenuAction,
        ]
      : []),
    ...(unfiled
      ? []
      : [
          {
            id: "move-up",
            title: "Move up",
            image: "arrow.up",
            attributes: { disabled: !props.canMoveUp },
          } satisfies MenuAction,
          {
            id: "move-down",
            title: "Move down",
            image: "arrow.down",
            attributes: { disabled: !props.canMoveDown },
          } satisfies MenuAction,
          {
            id: "delete",
            title: "Delete folder",
            image: "trash",
            attributes: { destructive: true },
          } satisfies MenuAction,
        ]),
  ];
  const act = (id: string) => {
    const action = menuActions.find((candidate) => candidate.id === id);
    if (props.disabled || action === undefined || action.attributes?.disabled === true) return;
    if (isFolderHeaderAction(id)) props.onAction(id);
  };
  return (
    <View>
      <View className={cn("mt-3 flex-row items-center", sidebarPane ? "pr-1.5" : "pr-3")}>
        <Menu
          actions={menuActions}
          className="min-w-0 flex-1"
          onPressAction={({ nativeEvent }) => act(nativeEvent.event)}
          shouldOpenOnLongPress
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${props.threadCount} ${props.threadCount === 1 ? "thread" : "threads"}`}
            accessibilityHint={`${props.collapsed ? "Shows" : "Hides"} this folder's threads. Long press for folder options.`}
            accessibilityState={{ disabled: props.disabled, expanded: !props.collapsed }}
            accessibilityActions={menuActions.flatMap((action) =>
              action.id !== undefined && action.attributes?.disabled !== true
                ? [{ name: action.id, label: action.title }]
                : [],
            )}
            onAccessibilityAction={({ nativeEvent }) => act(nativeEvent.actionName)}
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
                sidebarPane
                  ? "text-drawer-foreground-muted"
                  : unfiled
                    ? "text-foreground-muted"
                    : "text-foreground-secondary",
              )}
              numberOfLines={1}
            >
              {title}
            </Text>
            {props.isDefault ? (
              <Text
                accessibilityLabel="New threads go here"
                className="text-[11px] text-foreground-muted"
              >
                default
              </Text>
            ) : null}
            {props.collapsed && props.status !== null ? (
              <ThreadStatusIcon kind={props.status} />
            ) : null}
            {props.collapsed ? (
              <Text className="text-xs tabular-nums text-foreground-muted">
                {props.threadCount}
              </Text>
            ) : null}
          </Pressable>
        </Menu>
        {unfiled ? (
          <TreeIconButton
            icon="folder.badge.plus"
            label="New folder"
            tint={iconTint}
            disabled={props.disabled}
            onPress={() => act("new-folder")}
          />
        ) : null}
        {props.onNewThread ? (
          <TreeIconButton
            icon="square.and.pencil"
            label={`New thread in ${title}`}
            tint={iconTint}
            onPress={props.onNewThread}
          />
        ) : null}
      </View>
      {props.offerFolderPerProject && !props.collapsed ? (
        <Pressable
          accessibilityRole="button"
          className={cn(
            "flex-row items-center gap-2 py-2",
            sidebarPane ? "pl-8 pr-3" : "pl-10 pr-5",
          )}
          disabled={props.disabled}
          onPress={() => act("folder-per-project")}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <SymbolView
            name="folder.badge.plus"
            size={14}
            tintColorClassName={iconTint}
            type="monochrome"
          />
          <Text
            className={cn(
              "text-xs font-t3-medium",
              sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
            )}
          >
            Make a folder for each project
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

/** Fork (F20): a quiet mark on a thread the title model filed, until the user moves it or opens its menu. */
export function AutoFiledMark(props: {
  readonly tags: ReadonlyArray<string> | undefined;
  readonly selected: boolean;
}) {
  if (!isAutoFiledThread(props.tags)) return null;
  return (
    <Text
      accessibilityLabel="Auto-filed"
      className={cn("text-[11px]", props.selected ? "opacity-70" : "text-foreground-muted")}
    >
      auto
    </Text>
  );
}

export const ThreadTreeMoreRow = memo(function ThreadTreeMoreRow(props: {
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

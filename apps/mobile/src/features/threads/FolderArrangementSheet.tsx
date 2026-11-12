import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Modal, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SheetHeader } from "../../components/ui/SheetHeader";
import type { FolderMove } from "./projectThreadTree";
import { threadDragGapOffset } from "./threadDragGap";

const ROW_HEIGHT = 56;
const EDGE_SCROLL_ZONE = 48;

interface Drag {
  readonly folder: string;
  readonly startY: number;
  translation: number;
  target: FolderMove | null;
}

function ArrangementRow(props: {
  readonly offset: number;
  readonly lifted: boolean;
  readonly dragging: boolean;
  readonly children: ReactNode;
}) {
  const { dragging, offset, lifted } = props;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: dragging
          ? withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System })
          : offset,
      },
    ],
    opacity: lifted ? 0 : 1,
  }));
  return (
    <Reanimated.View
      style={[{ height: ROW_HEIGHT }, style]}
      className="flex-row items-center border-b border-border-subtle pl-5"
    >
      {props.children}
    </Reanimated.View>
  );
}

interface DragHandlers {
  readonly onStart: () => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (cancelled: boolean) => void;
}

/**
 * The pan gesture is built once, since rebuilding it on a re-render mid-drag
 * would cancel the drag. Its callbacks call whichever handlers were set last.
 */
function createDragGesture() {
  let handlers: DragHandlers | null = null;
  return {
    setHandlers: (next: DragHandlers) => {
      handlers = next;
    },
    gesture: Gesture.Pan()
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart(() => handlers?.onStart())
      .onUpdate((event) => handlers?.onMove(event.translationY))
      .onEnd((event) => handlers?.onMove(event.translationY))
      .onFinalize((_, success) => handlers?.onEnd(!success)),
  };
}

function DragHandle(
  props: DragHandlers & {
    readonly title: string;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
    readonly onStep: (direction: "up" | "down") => void;
  },
) {
  const [drag] = useState(createDragGesture);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the gesture runs outside React and needs the latest handlers
  useEffect(() => {
    drag.setHandlers(props);
  });
  return (
    <GestureDetector gesture={drag.gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Reorder ${props.title}`}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        className="size-14 items-center justify-center"
      >
        <SymbolView
          name="line.3.horizontal"
          size={22}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}

/** Fork (F20): drag folders into the order the Android thread tree keeps on this device. */
export function FolderArrangementSheet(props: {
  readonly folders: ReadonlyArray<string>;
  readonly onMove: (folder: string, move: FolderMove) => void;
  readonly onClose: () => void;
}) {
  const { folders } = props;
  const list = useRef<LegendListRef>(null);
  const geometry = useRef({ height: 0, offset: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<Drag | null>(null);
  const [translateY] = useState(() => new Animated.Value(0));

  function stop() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setPreview(null);
  }
  const orderVersion = folders.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a saved move ends the drag and its pending animation frame
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react/set-state-in-effect -- A saved move cancels the drag and clears its preview; stop only touches refs and state setters.
    stop();
  }, [orderVersion]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending animation frame on unmount
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  function update(translation: number) {
    const current = drag.current;
    if (current === null || folders.length === 0) return;
    current.translation = translation;
    const { height, offset } = geometry.current;
    const y = current.startY + translation;
    translateY.setValue(Math.max(0, Math.min(height - ROW_HEIGHT, y - ROW_HEIGHT / 2)));
    const contentY = Math.max(0, y + offset);
    const index = Math.min(folders.length - 1, Math.floor(contentY / ROW_HEIGHT));
    const row = folders[index]!;
    const target: FolderMove | null =
      row === current.folder || y < 0 || y > height
        ? null
        : {
            target: row,
            placement: contentY < index * ROW_HEIGHT + ROW_HEIGHT / 2 ? "before" : "after",
          };
    const previous = current.target;
    const changed =
      previous === null || target === null
        ? previous !== target
        : previous.target !== target.target || previous.placement !== target.placement;
    if (changed) {
      current.target = target;
      setPreview({ ...current });
    }
  }

  function start(folder: string, index: number) {
    if (drag.current !== null) return;
    drag.current = {
      folder,
      startY: index * ROW_HEIGHT + ROW_HEIGHT / 2 - geometry.current.offset,
      translation: 0,
      target: null,
    };
    setPreview({ ...drag.current });
    update(0);
    let last = performance.now();
    // Scrolls while a dragged row is held near the top or bottom edge.
    const tick = () => {
      const current = drag.current;
      if (!current) return;
      const timestamp = performance.now();
      const dt = Math.min(timestamp - last, 32);
      last = timestamp;
      const bounds = geometry.current;
      const y = current.startY + current.translation;
      const speed =
        y < EDGE_SCROLL_ZONE
          ? -Math.min(1, (EDGE_SCROLL_ZONE - y) / EDGE_SCROLL_ZONE)
          : y > bounds.height - EDGE_SCROLL_ZONE
            ? Math.min(1, (y - bounds.height + EDGE_SCROLL_ZONE) / EDGE_SCROLL_ZONE)
            : 0;
      const maximum = Math.max(0, folders.length * ROW_HEIGHT - bounds.height);
      const offset = Math.max(0, Math.min(maximum, bounds.offset + speed * dt * 0.5));
      if (offset !== bounds.offset) {
        bounds.offset = offset;
        list.current?.scrollToOffset({ offset, animated: false });
        update(current.translation);
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }

  function end(cancelled: boolean) {
    const current = drag.current;
    if (!cancelled && current?.target) props.onMove(current.folder, current.target);
    stop();
  }

  const sourceIndex = preview ? folders.indexOf(preview.folder) : -1;
  const targetIndex = preview?.target ? folders.indexOf(preview.target.target) : -1;
  const insertionOffset =
    targetIndex === -1
      ? sourceIndex * ROW_HEIGHT
      : targetIndex * ROW_HEIGHT + (preview?.target?.placement === "after" ? ROW_HEIGHT : 0);
  const draggedTitle = sourceIndex === -1 ? null : folders[sourceIndex]!;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A Modal is its own native hierarchy, so it measures its own safe area. */}
        <SafeAreaProvider style={{ flex: 1 }}>
          <View className="flex-1 bg-screen">
            <SafeAreaView style={{ flex: 1 }}>
              <SheetHeader
                presentation="inline"
                title="Arrange folders"
                onClose={props.onClose}
                accessibilityLabel="Close arrange folders"
              />
              <Text className="px-5 pb-3 text-sm text-foreground-muted">
                Drag to reorder. Folders stay in this order on this device.
              </Text>
              <View
                onLayout={(event) => {
                  geometry.current.height = event.nativeEvent.layout.height;
                }}
                className="flex-1"
                style={{ overflow: "hidden" }}
              >
                {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- A full-screen Modal with an inline header; there is no navigation header to register with. */}
                <LegendList
                  ref={list}
                  data={folders}
                  extraData={{ preview, folders, onMove: props.onMove }}
                  keyExtractor={(folder) => folder}
                  // Rows hold their drag gesture, so each keeps its own view.
                  recycleItems={false}
                  scrollEnabled={preview === null}
                  onScroll={(event) => {
                    geometry.current.offset = event.nativeEvent.contentOffset.y;
                  }}
                  scrollEventThrottle={16}
                  getFixedItemSize={() => ROW_HEIGHT}
                  renderItem={({ item, index }) => (
                    <ArrangementRow
                      dragging={preview !== null}
                      lifted={index === sourceIndex}
                      offset={
                        sourceIndex === -1
                          ? 0
                          : threadDragGapOffset(
                              index * ROW_HEIGHT,
                              sourceIndex * ROW_HEIGHT,
                              ROW_HEIGHT,
                              insertionOffset,
                            )
                      }
                    >
                      <Text numberOfLines={1} className="flex-1 text-base">
                        {item}
                      </Text>
                      <DragHandle
                        title={item}
                        canMoveUp={index > 0}
                        canMoveDown={index < folders.length - 1}
                        onStart={() => start(item, index)}
                        onMove={update}
                        onEnd={end}
                        onStep={(direction) => {
                          const neighbour = folders[direction === "up" ? index - 1 : index + 1];
                          if (neighbour === undefined) return;
                          props.onMove(item, {
                            target: neighbour,
                            placement: direction === "up" ? "before" : "after",
                          });
                        }}
                      />
                    </ArrangementRow>
                  )}
                />
                {draggedTitle !== null ? (
                  <Animated.View
                    pointerEvents="none"
                    className="absolute left-5 right-5 justify-center rounded-xl border border-border bg-screen px-4"
                    style={{ top: 0, height: ROW_HEIGHT, transform: [{ translateY }] }}
                  >
                    <Text numberOfLines={1} className="text-base font-t3-medium">
                      {draggedTitle}
                    </Text>
                  </Animated.View>
                ) : null}
              </View>
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

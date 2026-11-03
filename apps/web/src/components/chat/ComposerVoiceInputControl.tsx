import { useAtomValue } from "@effect/atom-react";
import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import {
  memo,
  use,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEventHandler,
} from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { shortcutLabelForCommand } from "../../keybindings";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { registerCommands } from "../../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { BackgroundThreadContext } from "./backgroundThread";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepComposerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};
const HOLD_TO_EDIT_MS = 500;

/**
 * Mic, then cancel / status / confirm while a dictation runs, as on mobile. Confirm sends the
 * message; holding it (or Shift-clicking) only puts the words in the draft. The voice input
 * shortcut (Mod+Shift+Space by default) starts a dictation and sends it; Escape cancels one.
 */
export const ComposerVoiceInputControl = memo(function ComposerVoiceInputControl(props: {
  readonly phase: VoiceInputPhase;
  readonly recordingStartedAt: number | null;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onConfirmWithoutSending: () => void;
  readonly onCancel: () => void;
}) {
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.voiceInput",
  );
  // Read at event time, so the scope registers once per mounted composer.
  const handleShortcut = useStableCallback((event: KeyboardEvent) => {
    if (props.phase === "idle" || props.phase === "error") {
      if (props.disabled) return false;
      event.preventDefault();
      if (!event.repeat) props.onStart();
      return true;
    }
    event.preventDefault();
    if (!event.repeat && props.phase === "recording") props.onConfirm();
    return true;
  });
  // Bubble phase, so a menu or dialog that takes Escape first keeps it.
  const cancelOnEscape = useStableCallback((event: KeyboardEvent) => {
    if (props.phase !== "recording" || event.key !== "Escape" || event.isComposing) return false;
    event.preventDefault();
    props.onCancel();
    return true;
  });
  const backgroundThread = use(BackgroundThreadContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the voice input shortcut with the command registry while the composer is mounted
  useEffect(() => {
    if (backgroundThread) return;
    return registerCommands(
      { "composer.voiceInput": handleShortcut },
      { onKeyDown: cancelOnEscape, when: (event) => !isInSideChatPane(event.target) },
    );
  }, [backgroundThread, cancelOnEscape, handleShortcut]);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clearHold = () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const startHold: PointerEventHandler<HTMLElement> = (event) => {
    keepComposerFocus(event);
    held.current = false;
    clearHold();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      held.current = true;
      props.onConfirmWithoutSending();
    }, HOLD_TO_EDIT_MS);
  };
  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    clearHold();
    if (held.current) {
      held.current = false;
      return;
    }
    if (event.shiftKey) props.onConfirmWithoutSending();
    else props.onConfirm();
  };

  if (props.phase === "idle" || props.phase === "error") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={props.disabled}
              onPointerDown={keepComposerFocus}
              onClick={props.onStart}
              aria-label="Voice input"
            />
          }
        >
          <MicIcon />
        </TooltipTrigger>
        <TooltipPopup>Voice input{shortcutLabel ? ` · ${shortcutLabel}` : null}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1" data-composer-voice-input={props.phase}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onPointerDown={keepComposerFocus}
        onClick={props.onCancel}
        aria-label="Cancel voice input"
      >
        <XIcon />
      </Button>
      <span className="flex min-w-14 items-center justify-center gap-1.5 text-muted-foreground text-xs tabular-nums">
        {props.phase === "recording" && props.recordingStartedAt !== null ? (
          <>
            <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
            <RecordingElapsed startedAt={props.recordingStartedAt} />
          </>
        ) : (
          <>
            <Spinner className="size-3.5" />
            {props.phase === "transcribing" ? "Transcribing" : "Starting"}
          </>
        )}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={props.phase !== "recording"}
              onPointerDown={startHold}
              onPointerUp={clearHold}
              onPointerLeave={clearHold}
              onClick={confirm}
              aria-label="Send voice message"
            />
          }
        >
          <CheckIcon />
        </TooltipTrigger>
        <TooltipPopup>
          Send{shortcutLabel ? ` · ${shortcutLabel}` : null} · hold or Shift-click to edit first
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

/** Ticks once a second, so only this label repaints while recording. */
function RecordingElapsed(props: { readonly startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advances the recording clock once a second
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - props.startedAt) / 1000));
  return (
    <span aria-label="Recording time">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

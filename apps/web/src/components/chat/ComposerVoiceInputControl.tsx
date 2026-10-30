import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { memo, useEffect, useState, type PointerEventHandler } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepComposerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

/** Mic, then cancel / status / confirm while a dictation runs, as on mobile. */
export const ComposerVoiceInputControl = memo(function ComposerVoiceInputControl(props: {
  readonly phase: VoiceInputPhase;
  readonly recordingStartedAt: number | null;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
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
        <TooltipPopup>Voice input</TooltipPopup>
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={props.phase !== "recording"}
        onPointerDown={keepComposerFocus}
        onClick={props.onConfirm}
        aria-label="Finish voice input"
      >
        <CheckIcon />
      </Button>
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

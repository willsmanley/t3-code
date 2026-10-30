import {
  VoiceInputController,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useState } from "react";

import {
  WEB_VOICE_RECORDING_LIMIT_SECONDS,
  WebVoiceRecorder,
  canRecordVoiceInput,
  getElevenLabsTranscriber,
  requestMicrophonePermission,
} from "../../voiceInput/elevenLabsVoiceInput";
import { toastManager } from "../ui/toast";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/**
 * Dictation into one composer through the controller mobile uses. `readDraft`
 * and `commitDraft` must be stable; they are bound once per composer. Errors
 * surface as toasts; the error phase still accepts another start.
 */
export function useComposerVoiceInput(input: {
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [controller] = useState(() => {
    const recorder = new WebVoiceRecorder((status) => {
      void controller.handleRecorderStatus(status);
    });
    const controller: VoiceInputController = new VoiceInputController({
      recorder,
      recordingLimitSeconds: WEB_VOICE_RECORDING_LIMIT_SECONDS,
      getTranscriber: getElevenLabsTranscriber,
      requestPermission: requestMicrophonePermission,
      configureRecording: async () => {},
      releaseRecording: async () => recorder.releaseStream(),
      deleteRecording: (uri) => URL.revokeObjectURL(uri),
      readDraft: input.readDraft,
      commitDraft: input.commitDraft,
      onStateChange: (next) => {
        setState(next);
        setRecordingStartedAt(next.phase === "recording" ? Date.now() : null);
        if (next.phase === "error" && next.error) {
          toastManager.add({
            type: "error",
            title: next.error,
            ...(next.errorAction === "settings"
              ? { description: "Allow the microphone for this site in the browser's settings." }
              : {}),
          });
        }
      },
    });
    return controller;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a recording belongs to the draft it started in, so switching drafts or unmounting cancels it and frees the microphone
  useEffect(
    () => () => controller.ownerChanged(),
    [
      controller,
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new draft or question ends the recording that belonged to the old one.
      input.ownerKey,
    ],
  );

  const start = () => {
    if (!canRecordVoiceInput()) {
      toastManager.add({
        type: "error",
        title: "This browser can't record here.",
        description: "Voice input needs the app over HTTPS or localhost.",
      });
      return;
    }
    void controller.start();
  };

  return {
    state,
    recordingStartedAt,
    start,
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}

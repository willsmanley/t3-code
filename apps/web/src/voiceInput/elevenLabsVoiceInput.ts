import {
  ELEVENLABS_SPEECH_TO_TEXT_FIELDS,
  ELEVENLABS_SPEECH_TO_TEXT_URL,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  transcribeWithElevenLabs,
  type VoiceRecorder,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

// The same ElevenLabs Scribe transcription as the fork's Android app (F8). The
// key is saved once on the server, so no browser or desktop app needs its own.
const getServerElevenLabsApiKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice-input:elevenlabs-api-key",
  tag: WS_METHODS.serverGetElevenLabsApiKey,
});

/** Android's limit, so a long dictation behaves the same on every client. */
export const WEB_VOICE_RECORDING_LIMIT_SECONDS = 20 * 60;

/** Transcribes with the ElevenLabs key saved on the thread's server. */
export function getElevenLabsTranscriber(environmentId: EnvironmentId): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        getServerElevenLabsApiKey,
        { environmentId, input: {} },
        { reportFailure: false },
      );
      throwIfVoiceTranscriptionAborted(signal);
      if (result._tag === "Failure") {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Could not get the ElevenLabs key from the server.",
        );
      }
      const apiKey = result.value.apiKey;
      if (!apiKey) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Voice input needs an ElevenLabs API key saved on the server.",
        );
      }
      return {
        locale: navigator.language,
        transcribe: (uri, { signal: transcribeSignal }) =>
          transcribeWithElevenLabs({
            upload: (uploadSignal) => uploadRecording(uri, apiKey, uploadSignal),
            signal: transcribeSignal,
          }),
      };
    },
  };
}

async function uploadRecording(uri: string, apiKey: string, signal: AbortSignal) {
  const audio = await (await fetch(uri, { signal })).blob();
  const body = new FormData();
  for (const [name, value] of Object.entries(ELEVENLABS_SPEECH_TO_TEXT_FIELDS)) {
    body.append(name, value);
  }
  body.append("file", audio, `recording.${audioExtension(audio.type)}`);
  const response = await fetch(ELEVENLABS_SPEECH_TO_TEXT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body,
    signal,
  });
  return { status: response.status, body: await response.text() };
}

function audioExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

/** False when the browser blocks the microphone outright, as on plain http origins. */
export function canRecordVoiceInput(): boolean {
  return (
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/**
 * Asks for the microphone without holding it: the recorder opens its own
 * stream once transcription is ready, so a failed start never leaves the
 * microphone on.
 */
export async function requestMicrophonePermission(): Promise<{
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { granted: true, canAskAgain: true };
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotAllowedError") throw error;
    const permission = await navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .catch(() => null);
    return { granted: false, canAskAgain: permission?.state !== "denied" };
  }
}

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

/**
 * MediaRecorder behind the shared controller's recorder interface. `uri` is a
 * blob URL that exists once recording stops; the controller revokes it through
 * `deleteRecording`. A recording that ends on its own (time limit, microphone
 * unplugged) reports through `onStatus` so the controller can transcribe it.
 */
export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped: Promise<void> | null = null;
  private stopRequested = false;
  private started = false;
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  async prepareToRecordAsync(): Promise<void> {
    this.releaseStream();
    this.uri = null;
    this.chunks = [];
    this.stopRequested = false;
    this.started = false;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      this.clearLimitTimer();
      this.releaseStream();
      this.onStatus({
        isFinished: false,
        hasError: true,
        error: "Voice recording was interrupted.",
        url: null,
      });
    });
    this.stopped = new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          this.clearLimitTimer();
          this.releaseStream();
          const type = recorder.mimeType || mimeType || "audio/webm";
          this.uri = URL.createObjectURL(new Blob(this.chunks, { type }));
          this.chunks = [];
          resolve();
          if (!this.stopRequested) {
            this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
          }
        },
        { once: true },
      );
    });
  }

  record(options: { readonly forDuration: number }): void {
    const recorder = this.recorder;
    if (!recorder) return;
    recorder.start();
    this.started = true;
    this.limitTimer = setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, options.forDuration * 1000);
  }

  async stop(): Promise<void> {
    this.clearLimitTimer();
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      this.stopRequested = true;
      recorder.stop();
    }
    // A recorder that never started has no stop event to wait for.
    if (this.started && this.stopped) await this.stopped;
    this.releaseStream();
  }

  releaseStream(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private clearLimitTimer(): void {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }
}

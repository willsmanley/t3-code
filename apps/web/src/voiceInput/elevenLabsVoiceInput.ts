import {
  ELEVENLABS_SPEECH_TO_TEXT_FIELDS,
  ELEVENLABS_SPEECH_TO_TEXT_URL,
  VoiceTranscriptionError,
  createElevenLabsTranscriber,
  pruneSavedTranscripts,
  type ElevenLabsRecordings,
  type VoiceRecorder,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { appendRecordingAudio, readRecordingAudio, webRecordings } from "./savedRecordings";

// The same ElevenLabs Scribe transcription as the fork's Android app (F8). The
// key is saved once on the server, so no browser or desktop app needs its own.
const getServerElevenLabsApiKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice-input:elevenlabs-api-key",
  tag: WS_METHODS.serverGetElevenLabsApiKey,
});

/** Android's limit, so a long dictation behaves the same on every client. */
export const WEB_VOICE_RECORDING_LIMIT_SECONDS = 20 * 60;
// MediaRecorder hands over audio this often, and each piece is saved as it comes.
const RECORDING_SLICE_MS = 1_000;

/** Kept recordings, transcribed with the key saved on the first of these servers that has one. */
export function webElevenLabsRecordings(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ElevenLabsRecordings {
  return {
    storage: webRecordings,
    readApiKey: () => readServerElevenLabsApiKey(environmentIds),
    missingKeyMessage: "Voice input needs an ElevenLabs API key saved on the server.",
    failureHint: "The recording is saved in Settings > Chat.",
    upload: uploadRecording,
  };
}

/** Transcribes with the ElevenLabs key saved on the thread's server. */
export function getElevenLabsTranscriber(environmentId: EnvironmentId): VoiceTranscriber {
  return createElevenLabsTranscriber(
    webElevenLabsRecordings([environmentId]),
    () => navigator.language,
  );
}

let prunedThisLoad = false;

/** Clears week-old transcripts once per page load, as Android does once per launch. */
export function pruneSavedTranscriptsOnce(): void {
  if (prunedThisLoad) return;
  prunedThisLoad = true;
  void pruneSavedTranscripts(webRecordings).catch(() => {});
}

async function readServerElevenLabsApiKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<string | null> {
  let reached = false;
  for (const environmentId of environmentIds) {
    const result = await runAtomCommand(
      appAtomRegistry,
      getServerElevenLabsApiKey,
      { environmentId, input: {} },
      { reportFailure: false },
    );
    if (result._tag === "Failure") continue;
    if (result.value.apiKey) return result.value.apiKey;
    reached = true;
  }
  if (!reached) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Could not get the ElevenLabs key from the server.",
    );
  }
  return null;
}

async function uploadRecording(uri: string, apiKey: string, signal: AbortSignal) {
  const audio = await readRecordingAudio(uri);
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
    typeof MediaRecorder !== "undefined" &&
    typeof indexedDB !== "undefined"
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
 * MediaRecorder behind the shared controller's recorder interface, saving audio
 * to IndexedDB a second at a time under `uri`. A recording that ends on its own
 * (time limit, microphone unplugged) reports through `onStatus`.
 */
export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private saving: Promise<void> = Promise.resolve();
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
    this.saving = Promise.resolve();
    this.stopRequested = false;
    this.started = false;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const id = randomUUID();
    this.recorder = recorder;
    this.uri = id;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      const type = recorder.mimeType || mimeType || "audio/webm";
      this.saving = this.saving
        .then(() => appendRecordingAudio(id, event.data, type))
        .catch(() => this.fail("Voice recording could not be saved."));
    });
    recorder.addEventListener("error", () => this.fail("Voice recording was interrupted."));
    this.stopped = new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          this.clearLimitTimer();
          this.releaseStream();
          // The last piece arrives just before `stop`; transcribe once it is saved.
          void this.saving.then(() => {
            resolve();
            if (!this.stopRequested) {
              this.onStatus({ isFinished: true, hasError: false, error: null, url: id });
            }
          });
        },
        { once: true },
      );
    });
  }

  record(options: { readonly forDuration: number }): void {
    const recorder = this.recorder;
    if (!recorder) return;
    recorder.start(RECORDING_SLICE_MS);
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

  private fail(error: string): void {
    this.clearLimitTimer();
    this.releaseStream();
    this.onStatus({ isFinished: false, hasError: true, error, url: null });
  }

  private clearLimitTimer(): void {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }
}

// @effect-diagnostics globalTimers:off - Retry waits run in client transcription, outside an Effect runtime.
import { releaseRecording, saveTranscript, type SavedRecordingStorage } from "./savedRecordings.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "./transcription.ts";

// The fork's Android and web voice input both transcribe with ElevenLabs Scribe.
export const ELEVENLABS_SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const ELEVENLABS_SPEECH_TO_TEXT_FIELDS = {
  model_id: "scribe_v2",
  tag_audio_events: "false",
} as const;
// About three minutes of retries rides out a dropped connection while the
// composer waits.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 60_000];

export type ElevenLabsUploadResponse = { readonly status: number; readonly body: string };

/**
 * Uploads a recording to ElevenLabs Scribe, retrying through network drops and
 * server errors. `failureHint` ends every failure message, for example to say
 * where the recording was kept.
 */
async function transcribeWithElevenLabs(options: {
  readonly upload: (signal: AbortSignal) => Promise<ElevenLabsUploadResponse>;
  readonly signal: AbortSignal;
  readonly failureHint?: string;
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<string> {
  const { upload, signal, wait = waitFor } = options;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const fail = (message: string) =>
    new VoiceTranscriptionError(
      "transcription-failed",
      options.failureHint ? `${message} ${options.failureHint}` : message,
    );
  for (let attempt = 0; ; attempt += 1) {
    throwIfVoiceTranscriptionAborted(signal);
    let response: ElevenLabsUploadResponse | null = null;
    try {
      response = await upload(signal);
    } catch {
      throwIfVoiceTranscriptionAborted(signal);
    }
    if (response !== null && response.status >= 200 && response.status < 300) {
      return parseTranscript(response.body);
    }
    if (response !== null && !isRetryable(response.status)) {
      throw fail(failureMessage(response));
    }
    const delay = delays[attempt];
    if (delay === undefined) throw fail("Could not reach ElevenLabs.");
    await wait(delay, signal);
  }
}

/** What a platform supplies to transcribe its kept recordings with ElevenLabs. */
export type ElevenLabsRecordings = {
  readonly storage: SavedRecordingStorage;
  readonly readApiKey: () => Promise<string | null>;
  /** The error when `readApiKey` finds no key. */
  readonly missingKeyMessage: string;
  /** Ends every failure message, to say where the recording is kept. */
  readonly failureHint: string;
  readonly upload: (
    audioUri: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<ElevenLabsUploadResponse>;
};

/**
 * Transcribes a kept recording. The transcript is saved beside the audio
 * before it is returned, which is what allows the audio to be deleted.
 */
export async function transcribeSavedRecording(
  recordings: ElevenLabsRecordings,
  audioUri: string,
  options: {
    readonly apiKey: string;
    readonly signal: AbortSignal;
    readonly retryDelaysMs?: ReadonlyArray<number>;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<string> {
  const transcript = await transcribeWithElevenLabs({
    upload: (signal) => recordings.upload(audioUri, options.apiKey, signal),
    signal: options.signal,
    failureHint: recordings.failureHint,
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
  // An empty result keeps the audio: a long recording with no words is
  // more likely a fault than silence.
  if (transcript.length > 0) await saveTranscript(recordings.storage, audioUri, transcript);
  return transcript;
}

/** The composer's transcriber. The key is read once per dictation. */
export function createElevenLabsTranscriber(
  recordings: ElevenLabsRecordings,
  locale: () => string,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      const apiKey = await requireApiKey(recordings, signal);
      return {
        locale: locale(),
        transcribe: (audioUri, { signal: transcribeSignal }) =>
          transcribeSavedRecording(recordings, audioUri, { apiKey, signal: transcribeSignal }),
      };
    },
  };
}

/**
 * Transcribes a kept recording again, from settings, without retries. Its
 * audio is deleted once words come back.
 */
export async function retrySavedRecording(
  recordings: ElevenLabsRecordings,
  audioUri: string,
): Promise<string> {
  const apiKey = await requireApiKey(recordings);
  const transcript = await transcribeSavedRecording(recordings, audioUri, {
    apiKey,
    signal: new AbortController().signal,
    retryDelaysMs: [],
  });
  if (transcript.length > 0) await releaseRecording(recordings.storage, audioUri);
  return transcript;
}

async function requireApiKey(
  recordings: ElevenLabsRecordings,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = await recordings.readApiKey();
  if (signal) throwIfVoiceTranscriptionAborted(signal);
  if (!apiKey) throw new VoiceTranscriptionError("unavailable", recordings.missingKeyMessage);
  return apiKey;
}

function parseTranscript(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
      return typeof parsed.text === "string" ? parsed.text.trim() : "";
    }
  } catch {}
  return "";
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function failureMessage(response: ElevenLabsUploadResponse): string {
  // ElevenLabs answers an exhausted quota with the same 401 as a bad key.
  if (response.body.includes('"quota_exceeded"')) return "ElevenLabs is out of credits.";
  if (response.status === 401) return "ElevenLabs rejected the API key.";
  return `ElevenLabs could not transcribe this recording (error ${response.status}).`;
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

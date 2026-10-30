// @effect-diagnostics globalTimers:off - Retry waits run in client transcription, outside an Effect runtime.
import { VoiceTranscriptionError, throwIfVoiceTranscriptionAborted } from "./transcription.ts";

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
export async function transcribeWithElevenLabs(options: {
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

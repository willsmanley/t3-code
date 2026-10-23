import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { File, UploadType } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { saveTranscript } from "./savedRecordings";

const API_KEY_STORAGE_KEY = "voice-input.elevenlabs-api-key";
const SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
// About three minutes of retries rides out a dropped connection while the
// composer waits; after that the recording stays saved for a later retry.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 60_000];
const SAVED_HINT = "The recording is saved in Settings > Microphone.";

type UploadResponse = { readonly status: number; readonly body: string };

export const readElevenLabsApiKey = () => SecureStore.getItemAsync(API_KEY_STORAGE_KEY);
export const saveElevenLabsApiKey = (apiKey: string) =>
  SecureStore.setItemAsync(API_KEY_STORAGE_KEY, apiKey.trim());
export const clearElevenLabsApiKey = () => SecureStore.deleteItemAsync(API_KEY_STORAGE_KEY);

export function getElevenLabsTranscriber(): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      const apiKey = await readElevenLabsApiKey();
      throwIfVoiceTranscriptionAborted(signal);
      if (!apiKey) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Add an ElevenLabs API key in Settings > Microphone to use voice input.",
        );
      }
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: (uri, { signal: transcribeSignal }) =>
          transcribeRecording(uri, { apiKey, signal: transcribeSignal }),
      };
    },
  };
}

/**
 * Uploads a saved recording to ElevenLabs Scribe, retrying through network
 * drops and server errors. The transcript is written beside the audio before
 * it is returned, which is what allows the audio to be deleted.
 */
export async function transcribeRecording(
  uri: string,
  options: {
    readonly apiKey: string;
    readonly signal: AbortSignal;
    readonly retryDelaysMs?: ReadonlyArray<number>;
    readonly upload?: (uri: string, apiKey: string, signal: AbortSignal) => Promise<UploadResponse>;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<string> {
  const { apiKey, signal, upload = uploadRecording, wait = waitFor } = options;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    throwIfVoiceTranscriptionAborted(signal);
    let response: UploadResponse | null = null;
    try {
      response = await upload(uri, apiKey, signal);
    } catch {
      throwIfVoiceTranscriptionAborted(signal);
    }
    if (response !== null && response.status >= 200 && response.status < 300) {
      const transcript = parseTranscript(response.body);
      // An empty result keeps the audio: a long recording with no words is
      // more likely a fault than silence.
      if (transcript.length > 0) await saveTranscript(uri, transcript);
      return transcript;
    }
    if (response !== null && !isRetryable(response.status)) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        `${failureMessage(response)} ${SAVED_HINT}`,
      );
    }
    const delay = delays[attempt];
    if (delay === undefined) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        `Could not reach ElevenLabs. ${SAVED_HINT}`,
      );
    }
    await wait(delay, signal);
  }
}

function uploadRecording(uri: string, apiKey: string, signal: AbortSignal) {
  return new File(uri).upload(SPEECH_TO_TEXT_URL, {
    httpMethod: "POST",
    uploadType: UploadType.MULTIPART,
    fieldName: "file",
    mimeType: "audio/aac",
    parameters: { model_id: "scribe_v2", tag_audio_events: "false" },
    headers: { "xi-api-key": apiKey },
    signal,
  });
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

function failureMessage(response: UploadResponse): string {
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

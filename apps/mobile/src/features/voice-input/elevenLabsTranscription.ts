import {
  ELEVENLABS_SPEECH_TO_TEXT_FIELDS,
  ELEVENLABS_SPEECH_TO_TEXT_URL,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  transcribeWithElevenLabs,
  type ElevenLabsUploadResponse,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { File, UploadType } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { saveTranscript } from "./savedRecordings";

const API_KEY_STORAGE_KEY = "voice-input.elevenlabs-api-key";
// After the shared retries give up, the recording stays saved for a later retry.
const SAVED_HINT = "The recording is saved in Settings > Microphone.";

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
    readonly upload?: (
      uri: string,
      apiKey: string,
      signal: AbortSignal,
    ) => Promise<ElevenLabsUploadResponse>;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<string> {
  const { apiKey, upload = uploadRecording } = options;
  const transcript = await transcribeWithElevenLabs({
    upload: (signal) => upload(uri, apiKey, signal),
    signal: options.signal,
    failureHint: SAVED_HINT,
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
  // An empty result keeps the audio: a long recording with no words is
  // more likely a fault than silence.
  if (transcript.length > 0) await saveTranscript(uri, transcript);
  return transcript;
}

function uploadRecording(uri: string, apiKey: string, signal: AbortSignal) {
  return new File(uri).upload(ELEVENLABS_SPEECH_TO_TEXT_URL, {
    httpMethod: "POST",
    uploadType: UploadType.MULTIPART,
    fieldName: "file",
    mimeType: "audio/aac",
    parameters: { ...ELEVENLABS_SPEECH_TO_TEXT_FIELDS },
    headers: { "xi-api-key": apiKey },
    signal,
  });
}

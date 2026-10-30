import {
  ELEVENLABS_SPEECH_TO_TEXT_FIELDS,
  ELEVENLABS_SPEECH_TO_TEXT_URL,
  createElevenLabsTranscriber,
  type ElevenLabsRecordings,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { File, UploadType } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { androidRecordings } from "./savedRecordings";

const API_KEY_STORAGE_KEY = "voice-input.elevenlabs-api-key";

export const readElevenLabsApiKey = () => SecureStore.getItemAsync(API_KEY_STORAGE_KEY);
export const saveElevenLabsApiKey = (apiKey: string) =>
  SecureStore.setItemAsync(API_KEY_STORAGE_KEY, apiKey.trim());
export const clearElevenLabsApiKey = () => SecureStore.deleteItemAsync(API_KEY_STORAGE_KEY);

/** Android's recordings, transcribed with the key saved on this phone. */
export const androidElevenLabsRecordings: ElevenLabsRecordings = {
  storage: androidRecordings,
  readApiKey: readElevenLabsApiKey,
  missingKeyMessage: "Add an ElevenLabs API key in Settings > Microphone to use voice input.",
  failureHint: "The recording is saved in Settings > Microphone.",
  upload: uploadRecording,
};

export function getElevenLabsTranscriber(): VoiceTranscriber {
  return createElevenLabsTranscriber(
    androidElevenLabsRecordings,
    () => Intl.DateTimeFormat().resolvedOptions().locale,
  );
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

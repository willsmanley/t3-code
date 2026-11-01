import {
  ELEVENLABS_SPEECH_TO_TEXT_FIELDS,
  ELEVENLABS_SPEECH_TO_TEXT_URL,
  createElevenLabsTranscriber,
  createServerDictationCommands,
  createServerDictationTranscriber,
  serverDictationTransport,
  type ElevenLabsRecordings,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import { File, FileMode, UploadType } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { androidRecordings } from "./savedRecordings";

const serverDictationCommands = createServerDictationCommands(connectionAtomRuntime);
let dictationEnvironmentId: EnvironmentId | null = null;

/** The server the next dictation streams to: the one that owns the composer's thread (F16). */
export function setDictationEnvironment(environmentId: EnvironmentId | null): void {
  dictationEnvironmentId = environmentId;
}

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

/**
 * Streams the recording to the thread's server, which transcribes it. Without a reachable
 * server that can, the recording goes straight to ElevenLabs with the key saved on this phone.
 */
export function getElevenLabsTranscriber(): VoiceTranscriber {
  const locale = () => Intl.DateTimeFormat().resolvedOptions().locale;
  return createServerDictationTranscriber({
    transport:
      dictationEnvironmentId === null
        ? null
        : serverDictationTransport(
            appAtomRegistry,
            serverDictationCommands,
            dictationEnvironmentId,
          ),
    read: readRecordingFrom,
    recordings: androidElevenLabsRecordings,
    source: "mobile",
    locale,
    fallback: createElevenLabsTranscriber(androidElevenLabsRecordings, locale),
  });
}

// ADTS is a run of self-contained frames, so a file still being recorded can be read up to its
// current end and the rest sent later.
async function readRecordingFrom(uri: string, offset: number, maxBytes: number) {
  const handle = new File(uri).open(FileMode.ReadOnly);
  try {
    const size = handle.size ?? 0;
    if (offset >= size) return { bytes: new Uint8Array(), mimeType: "audio/aac" };
    handle.offset = offset;
    return {
      bytes: await handle.readBytes(Math.min(size - offset, maxBytes)),
      mimeType: "audio/aac",
    };
  } finally {
    handle.close();
  }
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

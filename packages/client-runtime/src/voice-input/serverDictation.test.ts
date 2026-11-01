import { describe, expect, it, vi } from "vite-plus/test";

import type { ElevenLabsRecordings } from "./elevenLabs.ts";
import { memoryRecordingStorage } from "./savedRecordingsTestStorage.ts";
import {
  ServerDictationRejected,
  ServerDictationUnsupported,
  createServerDictationTranscriber,
  streamRecordingAudio,
  type ServerDictationTransport,
} from "./serverDictation.ts";
import type { VoiceTranscriber } from "./transcription.ts";

const URI = "audio:recording-1";
const HINT = "The recording is saved in Settings.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function setup(transport: ServerDictationTransport, fallback: VoiceTranscriber | null = null) {
  const { storage, recordings } = memoryRecordingStorage([
    { id: "recording-1", audioUri: URI, transcript: null, savedAt: 1 },
  ]);
  const elevenLabs: ElevenLabsRecordings = {
    storage,
    readApiKey: async () => "key",
    missingKeyMessage: "Add a key.",
    failureHint: HINT,
    upload: async () => ({ status: 500, body: "" }),
  };
  const audio = encoder.encode("hello world");
  const transcriber = createServerDictationTranscriber({
    transport,
    read: async (_uri, offset, maxBytes) => ({
      bytes: audio.subarray(offset, offset + maxBytes),
      mimeType: "audio/webm",
    }),
    recordings: elevenLabs,
    source: "web",
    locale: () => "en-US",
    fallback,
  });
  const transcribe = async () => {
    const prepared = await transcriber.prepare({ signal: new AbortController().signal });
    streamRecordingAudio(URI);
    return prepared.transcribe(URI, { signal: new AbortController().signal });
  };
  return { recordings, transcribe };
}

describe("createServerDictationTranscriber", () => {
  it("streams the recording, resends what the server lacks and saves the transcript", async () => {
    let held = new Uint8Array();
    const appended: Array<{ offset: number; text: string }> = [];
    const transcribeCalls: Array<{ totalBytes: number; source: string }> = [];
    const transport: ServerDictationTransport = {
      append: async ({ offset, data, dictationId }) => {
        expect(dictationId).toBe("recording-1");
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        appended.push({ offset, text: decoder.decode(bytes) });
        if (offset <= held.length) {
          const fresh = bytes.subarray(held.length - offset);
          held = new Uint8Array([...held, ...fresh]);
        }
        return { receivedBytes: held.length };
      },
      transcribe: async ({ totalBytes, source }) => {
        transcribeCalls.push({ totalBytes, source });
        if (transcribeCalls.length === 1) {
          held = held.subarray(0, 5);
          return { _tag: "incomplete", receivedBytes: 5 };
        }
        return { _tag: "transcribed", transcript: "Hello world." };
      },
    };
    const { recordings, transcribe } = setup(transport);

    await expect(transcribe()).resolves.toBe("Hello world.");
    expect(decoder.decode(held)).toBe("hello world");
    expect(appended).toEqual([
      { offset: 0, text: "hello world" },
      { offset: 5, text: " world" },
    ]);
    expect(transcribeCalls).toEqual([
      { totalBytes: 11, source: "web" },
      { totalBytes: 11, source: "web" },
    ]);
    expect(recordings.get("recording-1")?.transcript).toBe("Hello world.");
  });

  it("falls back on a server that can't transcribe, but not past the server's own error", async () => {
    const fallbackTranscribe = vi.fn(async () => "From ElevenLabs.");
    const fallback: VoiceTranscriber = {
      prepare: async () => ({ locale: "en-US", transcribe: fallbackTranscribe }),
    };
    const unsupported = setup(
      {
        append: async () => {
          throw new ServerDictationUnsupported();
        },
        transcribe: async () => {
          throw new ServerDictationUnsupported();
        },
      },
      fallback,
    );
    await expect(unsupported.transcribe()).resolves.toBe("From ElevenLabs.");
    expect(fallbackTranscribe).toHaveBeenCalledTimes(1);

    const outOfCredits = setup(
      {
        append: async ({ data }) => ({ receivedBytes: atob(data).length }),
        transcribe: async () => {
          throw new ServerDictationRejected("out-of-credits", "ElevenLabs is out of credits.");
        },
      },
      fallback,
    );
    await expect(outOfCredits.transcribe()).rejects.toThrow(
      `ElevenLabs is out of credits. ${HINT}`,
    );
    expect(fallbackTranscribe).toHaveBeenCalledTimes(1);
    expect(outOfCredits.recordings.get("recording-1")?.transcript).toBeNull();
  });
});

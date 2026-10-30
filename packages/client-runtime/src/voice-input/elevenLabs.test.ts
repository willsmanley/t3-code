import { describe, expect, it, vi } from "vite-plus/test";

import {
  createElevenLabsTranscriber,
  retrySavedRecording,
  transcribeSavedRecording,
  type ElevenLabsRecordings,
  type ElevenLabsUploadResponse,
} from "./elevenLabs.ts";
import { memoryRecordingStorage } from "./savedRecordingsTestStorage.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const URI = "audio:recording-1";
const HINT = "The recording is saved in Settings.";
const ok = (text: string) => ({ status: 200, body: JSON.stringify({ text }) });

function setup(
  responses: ReadonlyArray<ElevenLabsUploadResponse | Error>,
  apiKey: string | null = "key",
) {
  const { storage, recordings } = memoryRecordingStorage([
    { id: "recording-1", audioUri: URI, transcript: null, savedAt: 1 },
  ]);
  const upload = vi.fn(async (_uri: string, _apiKey: string, _signal: AbortSignal) => {
    const next = responses[upload.mock.calls.length - 1];
    if (next === undefined || next instanceof Error) throw next ?? new Error("offline");
    return next;
  });
  const elevenLabs: ElevenLabsRecordings = {
    storage,
    readApiKey: async () => apiKey,
    missingKeyMessage: "Add a key.",
    failureHint: HINT,
    upload,
  };
  return { elevenLabs, recordings, upload };
}

function transcribe(
  responses: ReadonlyArray<ElevenLabsUploadResponse | Error>,
  signal = new AbortController().signal,
) {
  const { elevenLabs, recordings, upload } = setup(responses);
  const wait = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {});
  const result = transcribeSavedRecording(elevenLabs, URI, {
    apiKey: "key",
    signal,
    retryDelaysMs: [1, 2, 3],
    wait,
  });
  return { result, recordings, upload, wait };
}

describe("transcribeSavedRecording", () => {
  it("retries a dropped connection and a server error, then saves the transcript", async () => {
    const { result, recordings, upload, wait } = transcribe([
      new Error("Network request failed"),
      { status: 503, body: "" },
      ok(" Run the Android build. "),
    ]);

    await expect(result).resolves.toBe("Run the Android build.");
    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls[0]?.slice(0, 2)).toEqual([URI, "key"]);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1, 2]);
    expect(recordings.get("recording-1")?.transcript).toBe("Run the Android build.");
  });

  it("keeps the recording when ElevenLabs is out of credits", async () => {
    const { result, recordings, upload } = transcribe([
      { status: 401, body: '{"detail":{"code":"quota_exceeded"}}' },
    ]);

    await expect(result).rejects.toThrow(`ElevenLabs is out of credits. ${HINT}`);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(recordings.get("recording-1")?.transcript).toBeNull();
  });

  it("gives up after the last retry and keeps the recording", async () => {
    const { result, recordings, upload } = transcribe([]);

    await expect(result).rejects.toThrow("Could not reach ElevenLabs.");
    expect(upload).toHaveBeenCalledTimes(4);
    expect(recordings.get("recording-1")?.transcript).toBeNull();
  });

  it("stops retrying once cancelled", async () => {
    const controller = new AbortController();
    const { elevenLabs, upload } = setup([]);
    const result = transcribeSavedRecording(elevenLabs, URI, {
      apiKey: "key",
      signal: controller.signal,
      wait: async () => controller.abort(),
    });

    await expect(result).rejects.toBeInstanceOf(VoiceTranscriptionError);
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps the audio when no words come back", async () => {
    const { result, recordings } = transcribe([ok("")]);

    await expect(result).resolves.toBe("");
    expect(recordings.get("recording-1")?.transcript).toBeNull();
  });
});

describe("createElevenLabsTranscriber", () => {
  it("reports a missing key before recording starts", async () => {
    const { elevenLabs } = setup([], null);
    const prepared = createElevenLabsTranscriber(elevenLabs, () => "en-US").prepare({
      signal: new AbortController().signal,
    });

    await expect(prepared).rejects.toMatchObject({ code: "unavailable", message: "Add a key." });
  });

  it("keeps the audio after transcribing, for the controller to release", async () => {
    const { elevenLabs, recordings } = setup([ok("Hello.")]);
    const prepared = await createElevenLabsTranscriber(elevenLabs, () => "en-US").prepare({
      signal: new AbortController().signal,
    });

    await expect(prepared.transcribe(URI, { signal: new AbortController().signal })).resolves.toBe(
      "Hello.",
    );
    expect(recordings.get("recording-1")).toMatchObject({ audioUri: URI, transcript: "Hello." });
  });
});

describe("retrySavedRecording", () => {
  it("tries once and deletes the audio when words come back", async () => {
    const { elevenLabs, recordings, upload } = setup([ok("Hello.")]);

    await expect(retrySavedRecording(elevenLabs, URI)).resolves.toBe("Hello.");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(recordings.get("recording-1")).toMatchObject({ audioUri: null, transcript: "Hello." });
  });

  it("does not retry a failed upload", async () => {
    const { elevenLabs, recordings, upload } = setup([new Error("offline")]);

    await expect(retrySavedRecording(elevenLabs, URI)).rejects.toThrow(
      `Could not reach ElevenLabs. ${HINT}`,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(recordings.get("recording-1")?.audioUri).toBe(URI);
  });
});

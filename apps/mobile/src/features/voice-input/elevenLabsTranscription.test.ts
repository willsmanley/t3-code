import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  saveTranscript: vi.fn<(uri: string, transcript: string) => Promise<void>>(),
}));

vi.mock("expo-file-system", () => ({ File: class {}, UploadType: { MULTIPART: 1 } }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./savedRecordings", () => ({ saveTranscript: mocks.saveTranscript }));

import { transcribeRecording } from "./elevenLabsTranscription";

const URI = "file:///data/files/Audio/recording-1.aac";
const ok = (text: string) => ({ status: 200, body: JSON.stringify({ text }) });

function transcribe(
  responses: ReadonlyArray<{ status: number; body: string } | Error>,
  signal = new AbortController().signal,
) {
  const upload = vi.fn(async () => {
    const next = responses[upload.mock.calls.length - 1];
    if (next === undefined || next instanceof Error) throw next ?? new Error("offline");
    return next;
  });
  const wait = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {});
  const result = transcribeRecording(URI, {
    apiKey: "key",
    signal,
    retryDelaysMs: [1, 2, 3],
    upload,
    wait,
  });
  return { result, upload, wait };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("transcribeRecording", () => {
  it("retries a dropped connection and a server error, then saves the transcript", async () => {
    mocks.saveTranscript.mockResolvedValue();
    const { result, upload, wait } = transcribe([
      new Error("Network request failed"),
      { status: 503, body: "" },
      ok(" Run the Android build. "),
    ]);

    await expect(result).resolves.toBe("Run the Android build.");
    expect(upload).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1, 2]);
    expect(mocks.saveTranscript).toHaveBeenCalledWith(URI, "Run the Android build.");
  });

  it("keeps the recording when ElevenLabs is out of credits", async () => {
    const { result, upload } = transcribe([
      { status: 401, body: '{"detail":{"code":"quota_exceeded"}}' },
    ]);

    await expect(result).rejects.toThrow(
      "ElevenLabs is out of credits. The recording is saved in Settings > Microphone.",
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(mocks.saveTranscript).not.toHaveBeenCalled();
  });

  it("gives up after the last retry and keeps the recording", async () => {
    const { result, upload } = transcribe([]);

    await expect(result).rejects.toThrow("Could not reach ElevenLabs.");
    expect(upload).toHaveBeenCalledTimes(4);
    expect(mocks.saveTranscript).not.toHaveBeenCalled();
  });

  it("stops retrying once cancelled", async () => {
    const controller = new AbortController();
    const upload = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = transcribeRecording(URI, {
      apiKey: "key",
      signal: controller.signal,
      upload,
      wait: async () => controller.abort(),
    });

    await expect(result).rejects.toBeInstanceOf(VoiceTranscriptionError);
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps the audio when no words come back", async () => {
    const { result } = transcribe([ok("")]);

    await expect(result).resolves.toBe("");
    expect(mocks.saveTranscript).not.toHaveBeenCalled();
  });
});

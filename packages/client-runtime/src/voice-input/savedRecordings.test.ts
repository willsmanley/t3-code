import { describe, expect, it } from "vite-plus/test";

import {
  deleteSavedRecording,
  listSavedRecordings,
  pruneSavedTranscripts,
  releaseRecording,
} from "./savedRecordings.ts";
import { memoryRecordingStorage } from "./savedRecordingsTestStorage.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("saved recordings", () => {
  it("lists the newest recording first", async () => {
    const { storage } = memoryRecordingStorage([
      { id: "old", audioUri: "audio:old", transcript: null, savedAt: 1 },
      { id: "new", audioUri: "audio:new", transcript: null, savedAt: 2 },
    ]);

    expect((await listSavedRecordings(storage)).map((recording) => recording.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("keeps audio until its transcript is saved", async () => {
    const { storage, recordings } = memoryRecordingStorage([
      { id: "a", audioUri: "audio:a", transcript: null, savedAt: 1 },
    ]);

    await releaseRecording(storage, "audio:a");
    expect(recordings.get("a")?.audioUri).toBe("audio:a");

    await storage.writeTranscript("a", "Hello.");
    await releaseRecording(storage, "audio:a");
    expect(recordings.get("a")).toMatchObject({ audioUri: null, transcript: "Hello." });
  });

  it("deletes the audio and transcript together", async () => {
    const { storage, recordings } = memoryRecordingStorage([
      { id: "a", audioUri: "audio:a", transcript: "Hello.", savedAt: 1 },
    ]);

    await deleteSavedRecording(storage, recordings.get("a")!);
    expect(recordings.size).toBe(0);
  });

  it("prunes week-old transcripts whose audio is gone", async () => {
    const now = 30 * DAY_MS;
    const { storage, recordings } = memoryRecordingStorage([
      { id: "stale", audioUri: null, transcript: "Old.", savedAt: now - 8 * DAY_MS },
      { id: "fresh", audioUri: null, transcript: "New.", savedAt: now - DAY_MS },
      { id: "with-audio", audioUri: "audio:w", transcript: "Kept.", savedAt: 0 },
    ]);

    await pruneSavedTranscripts(storage, now);
    expect([...recordings.keys()].toSorted()).toEqual(["fresh", "with-audio"]);
  });
});

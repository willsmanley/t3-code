import type { SavedRecording, SavedRecordingStorage } from "./savedRecordings.ts";

/** Recordings kept in memory, keyed by id, with `audio:<id>` as the audio URI. */
export function memoryRecordingStorage(initial: ReadonlyArray<SavedRecording> = []) {
  const recordings = new Map(initial.map((recording) => [recording.id, recording]));
  const update = (id: string, change: Partial<SavedRecording>) => {
    const next = {
      id,
      audioUri: null,
      transcript: null,
      savedAt: 0,
      ...recordings.get(id),
      ...change,
    };
    if (next.audioUri === null && next.transcript === null) recordings.delete(id);
    else recordings.set(id, next);
  };
  const storage: SavedRecordingStorage = {
    list: async () => [...recordings.values()],
    idForUri: (audioUri) => audioUri.replace(/^audio:/, ""),
    writeTranscript: async (id, transcript) => update(id, { transcript }),
    deleteAudio: async (id) => update(id, { audioUri: null }),
    deleteTranscript: async (id) => update(id, { transcript: null }),
  };
  return { storage, recordings };
}

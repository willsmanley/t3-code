// @effect-diagnostics globalDate:off - Pruning runs in client storage code, outside an Effect runtime.
// Recordings are kept on the device as they are recorded. Audio is deleted only
// once its transcript is saved beside it; until then settings lists it for
// another try. Android keeps them in document storage, web in IndexedDB.
const TRANSCRIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SavedRecording = {
  readonly id: string;
  readonly audioUri: string | null;
  readonly transcript: string | null;
  readonly savedAt: number;
};

/** Where a platform keeps recordings and their transcripts. */
export interface SavedRecordingStorage {
  readonly list: () => Promise<ReadonlyArray<SavedRecording>>;
  /** The id of the recording an audio URI belongs to. */
  readonly idForUri: (audioUri: string) => string;
  readonly writeTranscript: (id: string, transcript: string) => Promise<void>;
  readonly deleteAudio: (id: string) => Promise<void>;
  readonly deleteTranscript: (id: string) => Promise<void>;
}

export async function listSavedRecordings(
  storage: SavedRecordingStorage,
): Promise<SavedRecording[]> {
  return [...(await storage.list())].sort((left, right) => right.savedAt - left.savedAt);
}

export function saveTranscript(
  storage: SavedRecordingStorage,
  audioUri: string,
  transcript: string,
): Promise<void> {
  return storage.writeTranscript(storage.idForUri(audioUri), transcript);
}

/** Deletes a recording's audio, but only once its transcript has been saved. */
export async function releaseRecording(
  storage: SavedRecordingStorage,
  audioUri: string,
): Promise<void> {
  const id = storage.idForUri(audioUri);
  const recording = (await storage.list()).find((entry) => entry.id === id);
  if (recording?.audioUri && recording.transcript !== null) await storage.deleteAudio(id);
}

export async function deleteSavedRecording(
  storage: SavedRecordingStorage,
  recording: SavedRecording,
): Promise<void> {
  await storage.deleteAudio(recording.id);
  await storage.deleteTranscript(recording.id);
}

/** Transcripts are kept for a week so a transcript that never reached its draft can be copied. */
export async function pruneSavedTranscripts(
  storage: SavedRecordingStorage,
  now = Date.now(),
): Promise<void> {
  for (const recording of await storage.list()) {
    if (
      recording.audioUri === null &&
      recording.transcript !== null &&
      now - recording.savedAt > TRANSCRIPT_RETENTION_MS
    ) {
      await storage.deleteTranscript(recording.id);
    }
  }
}

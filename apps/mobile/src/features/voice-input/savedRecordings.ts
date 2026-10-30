import type { SavedRecording, SavedRecordingStorage } from "@t3tools/client-runtime/voice-input";
import { Directory, File, Paths } from "expo-file-system";

/**
 * Android records into document storage rather than the cache, so a long
 * recording survives a crash, a dead battery or a failed upload. The rules for
 * keeping and deleting recordings are shared with web, in
 * `@t3tools/client-runtime/voice-input`; this is only where the files live.
 */
// expo-audio writes recordings made with `directory: "document"` here.
const RECORDINGS_DIRECTORY = "Audio";
const TRANSCRIPT_EXTENSION = ".txt";

function recordingsDirectory(): Directory {
  const directory = new Directory(Paths.document, RECORDINGS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function recordingFiles(): File[] {
  return recordingsDirectory()
    .list()
    .filter((entry): entry is File => entry instanceof File);
}

function recordingId(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

const isTranscript = (file: File) => file.name.endsWith(TRANSCRIPT_EXTENSION);

function deleteFiles(id: string, transcript: boolean): void {
  for (const file of recordingFiles()) {
    if (recordingId(file.name) === id && isTranscript(file) === transcript) file.delete();
  }
}

/** Each recording's audio and its transcript are files with the same name in one folder. */
export const androidRecordings: SavedRecordingStorage = {
  list: async () => {
    const byId = new Map<string, SavedRecording>();
    for (const file of recordingFiles()) {
      const id = recordingId(file.name);
      const recording = byId.get(id) ?? { id, audioUri: null, transcript: null, savedAt: 0 };
      byId.set(id, {
        ...recording,
        ...(isTranscript(file) ? { transcript: await file.text() } : { audioUri: file.uri }),
        savedAt: Math.max(recording.savedAt, file.info().modificationTime ?? 0),
      });
    }
    return [...byId.values()];
  },
  idForUri: (audioUri) => recordingId(new File(audioUri).name),
  writeTranscript: async (id, transcript) => {
    const file = new File(recordingsDirectory(), `${id}${TRANSCRIPT_EXTENSION}`);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    await file.write(transcript);
  },
  deleteAudio: async (id) => deleteFiles(id, false),
  deleteTranscript: async (id) => deleteFiles(id, true),
};

import { Directory, File, Paths } from "expo-file-system";

/**
 * Android records into document storage rather than the cache, so a long
 * recording survives a crash, a dead battery or a failed upload. Audio is only
 * deleted once its transcript is written beside it; until then it is listed in
 * Settings > Microphone and can be transcribed again.
 */
// expo-audio writes recordings made with `directory: "document"` here.
const RECORDINGS_DIRECTORY = "Audio";
const TRANSCRIPT_EXTENSION = ".txt";
const TRANSCRIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SavedRecording = {
  readonly id: string;
  readonly audioUri: string | null;
  readonly transcript: string | null;
  readonly savedAt: number;
};

function recordingsDirectory(): Directory {
  const directory = new Directory(Paths.document, RECORDINGS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function recordingId(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

function transcriptFile(audio: File): File {
  return new File(audio.parentDirectory, `${recordingId(audio.name)}${TRANSCRIPT_EXTENSION}`);
}

function modifiedAt(file: File): number {
  return file.info().modificationTime ?? 0;
}

export async function saveTranscript(audioUri: string, transcript: string): Promise<void> {
  const file = transcriptFile(new File(audioUri));
  if (!file.exists) file.create({ intermediates: true, overwrite: true });
  await file.write(transcript);
}

/** Deletes a recording's audio, but only once its transcript has been saved. */
export function releaseRecording(audioUri: string): void {
  const audio = new File(audioUri);
  if (audio.exists && transcriptFile(audio).exists) audio.delete();
}

export async function listSavedRecordings(): Promise<SavedRecording[]> {
  const byId = new Map<
    string,
    { audioUri: string | null; transcript: string | null; savedAt: number }
  >();
  for (const entry of recordingsDirectory().list()) {
    if (!(entry instanceof File)) continue;
    const id = recordingId(entry.name);
    const recording = byId.get(id) ?? { audioUri: null, transcript: null, savedAt: 0 };
    if (entry.name.endsWith(TRANSCRIPT_EXTENSION)) {
      recording.transcript = await entry.text();
    } else {
      recording.audioUri = entry.uri;
    }
    recording.savedAt = Math.max(recording.savedAt, modifiedAt(entry));
    byId.set(id, recording);
  }
  return [...byId.entries()]
    .map(([id, recording]) => ({ id, ...recording }))
    .sort((left, right) => right.savedAt - left.savedAt);
}

export function deleteSavedRecording(recording: SavedRecording): void {
  for (const entry of recordingsDirectory().list()) {
    if (entry instanceof File && recordingId(entry.name) === recording.id) entry.delete();
  }
}

/** Transcripts are kept for a week so a transcript that never reached its draft can be copied. */
export function pruneSavedTranscripts(now = Date.now()): void {
  const files = recordingsDirectory()
    .list()
    .filter((entry): entry is File => entry instanceof File);
  const withAudio = new Set(
    files
      .filter((file) => !file.name.endsWith(TRANSCRIPT_EXTENSION))
      .map((file) => recordingId(file.name)),
  );
  for (const file of files) {
    if (
      file.name.endsWith(TRANSCRIPT_EXTENSION) &&
      !withAudio.has(recordingId(file.name)) &&
      now - modifiedAt(file) > TRANSCRIPT_RETENTION_MS
    ) {
      file.delete();
    }
  }
}

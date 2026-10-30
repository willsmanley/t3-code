import type { SavedRecording, SavedRecordingStorage } from "@t3tools/client-runtime/voice-input";

// Where web and desktop keep voice recordings: IndexedDB, saved a piece at a
// time while recording. The keep and delete rules are shared with Android in
// `@t3tools/client-runtime/voice-input`. A recording's id is its audio URI.
const DATABASE_NAME = "t3code:voice-recordings";
const DATABASE_VERSION = 1;
const RECORDINGS = "recordings";
const CHUNKS = "chunks";

type StoredRecording = {
  readonly id: string;
  readonly mimeType: string;
  readonly hasAudio: boolean;
  readonly transcript: string | null;
  readonly savedAt: number;
};
type StoredChunk = { readonly recordingId: string; readonly data: Blob };
type Stores = { readonly recordings: IDBObjectStore; readonly chunks: IDBObjectStore };

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(RECORDINGS, { keyPath: "id" });
      request.result
        .createObjectStore(CHUNKS, { autoIncrement: true })
        .createIndex("recordingId", "recordingId");
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Voice recordings are blocked.")));
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  }));
}

async function transact<A>(mode: IDBTransactionMode, use: (stores: Stores) => A): Promise<A> {
  const transaction = (await openDatabase()).transaction([RECORDINGS, CHUNKS], mode);
  const result = use({
    recordings: transaction.objectStore(RECORDINGS),
    chunks: transaction.objectStore(CHUNKS),
  });
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return result;
}

/** Rewrites one recording inside the caller's transaction; null removes it. */
function update(
  recordings: IDBObjectStore,
  id: string,
  change: (current: StoredRecording | undefined) => StoredRecording | null,
): void {
  const request = recordings.get(id);
  request.addEventListener("success", () => {
    const next = change(request.result as StoredRecording | undefined);
    if (next === null) recordings.delete(id);
    else recordings.put(next);
  });
}

export const webRecordings: SavedRecordingStorage = {
  list: async () => {
    const request = await transact("readonly", ({ recordings }) => recordings.getAll());
    return (request.result as StoredRecording[]).map((recording): SavedRecording => ({
      id: recording.id,
      audioUri: recording.hasAudio ? recording.id : null,
      transcript: recording.transcript,
      savedAt: recording.savedAt,
    }));
  },
  idForUri: (audioUri) => audioUri,
  writeTranscript: (id, transcript) =>
    transact("readwrite", ({ recordings }) =>
      update(recordings, id, (current) => ({
        id,
        mimeType: current?.mimeType ?? "",
        hasAudio: current?.hasAudio ?? false,
        transcript,
        savedAt: Date.now(),
      })),
    ),
  deleteAudio: (id) =>
    transact("readwrite", ({ recordings, chunks }) => {
      const cursor = chunks.index("recordingId").openKeyCursor(IDBKeyRange.only(id));
      cursor.addEventListener("success", () => {
        if (!cursor.result) return;
        chunks.delete(cursor.result.primaryKey);
        cursor.result.continue();
      });
      update(recordings, id, (current) =>
        !current || current.transcript === null ? null : { ...current, hasAudio: false },
      );
    }),
  deleteTranscript: (id) =>
    transact("readwrite", ({ recordings }) =>
      update(recordings, id, (current) =>
        !current?.hasAudio ? null : { ...current, transcript: null },
      ),
    ),
};

/** Saves the next piece of a recording as the browser hands it over. */
export function appendRecordingAudio(id: string, data: Blob, mimeType: string): Promise<void> {
  return transact("readwrite", ({ recordings, chunks }) => {
    chunks.add({ recordingId: id, data } satisfies StoredChunk);
    update(recordings, id, (current) => ({
      id,
      mimeType,
      hasAudio: true,
      transcript: current?.transcript ?? null,
      savedAt: Date.now(),
    }));
  });
}

/** A recording's saved pieces, joined back into one file. */
export async function readRecordingAudio(id: string): Promise<Blob> {
  const [chunks, recording] = await transact(
    "readonly",
    (stores) => [stores.chunks.index("recordingId").getAll(id), stores.recordings.get(id)] as const,
  );
  return new Blob(
    (chunks.result as StoredChunk[]).map((chunk) => chunk.data),
    { type: (recording.result as StoredRecording | undefined)?.mimeType ?? "" },
  );
}

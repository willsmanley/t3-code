// @effect-diagnostics globalTimers:off globalDate:off - Upload pacing runs in client transcription, outside an Effect runtime.
import type { ElevenLabsRecordings } from "./elevenLabs.ts";
import { saveTranscript } from "./savedRecordings.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "./transcription.ts";

// Fork (F16): audio goes to the thread's server while you talk, and the server transcribes it
// with ElevenLabs when the recording ends, so only the last second is still uploading then.

const MAX_CHUNK_BYTES = 256 * 1024;
const STREAM_INTERVAL_MS = 1_000;
const APPEND_TIMEOUT_MS = 15_000;
/** The server's ElevenLabs upload takes longer for a long recording. */
const transcribeTimeoutMs = (bytes: number) => 45_000 + (bytes / 1_048_576) * 30_000;
/** How long a recording waits for an unreachable server before going straight to ElevenLabs. */
const SERVER_DEADLINE_MS = 90_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

export type ServerDictationTranscribeResult =
  | { readonly _tag: "incomplete"; readonly receivedBytes: number }
  | { readonly _tag: "transcribed"; readonly transcript: string };

/**
 * The server's dictation RPCs. Failures throw: `ServerDictationRejected` when the server
 * answered with its own error, `ServerDictationUnsupported` when it lacks these RPCs, and
 * anything else for a connection problem worth retrying.
 */
export type ServerDictationTransport = {
  readonly append: (input: {
    readonly dictationId: string;
    readonly offset: number;
    readonly data: string;
    readonly mimeType: string;
  }) => Promise<{ readonly receivedBytes: number }>;
  readonly transcribe: (input: {
    readonly dictationId: string;
    readonly totalBytes: number;
    readonly mimeType: string;
    readonly source: "web" | "mobile";
    readonly recordingMs?: number;
    readonly uploadAfterStopMs?: number;
  }) => Promise<ServerDictationTranscribeResult>;
};

export class ServerDictationRejected extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "ServerDictationRejected";
    this.reason = reason;
  }
}

export class ServerDictationUnsupported extends Error {
  constructor() {
    super("This server cannot transcribe voice input.");
    this.name = "ServerDictationUnsupported";
  }
}

/** Reads up to `maxBytes` of a recording from `offset`, however far it has been written. */
export type RecordingAudioReader = (
  uri: string,
  offset: number,
  maxBytes: number,
) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function dictationIdFor(recordings: ElevenLabsRecordings, uri: string): string {
  return recordings.storage
    .idForUri(uri)
    .replaceAll(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 128);
}

class ServerDictationUnreachable extends Error {
  constructor() {
    super("Could not reach the server.");
    this.name = "ServerDictationUnreachable";
  }
}

class ServerDictationUpload {
  private uri: string | null = null;
  private sentBytes = 0;
  private mimeType = "application/octet-stream";
  private pumping: Promise<void> | null = null;
  private lastPumpAt = 0;
  private readonly startedAt = Date.now();
  private readonly transport: ServerDictationTransport;
  private readonly read: RecordingAudioReader;
  private readonly recordings: ElevenLabsRecordings;
  private readonly source: "web" | "mobile";

  constructor(
    transport: ServerDictationTransport,
    read: RecordingAudioReader,
    recordings: ElevenLabsRecordings,
    source: "web" | "mobile",
  ) {
    this.transport = transport;
    this.read = read;
    this.recordings = recordings;
    this.source = source;
  }

  /** Sends what was recorded since the last call, at most once a second. Never throws. */
  stream(uri: string): void {
    if (this.uri !== null && this.uri !== uri) return;
    this.uri = uri;
    if (this.pumping || Date.now() - this.lastPumpAt < STREAM_INTERVAL_MS) return;
    this.lastPumpAt = Date.now();
    void this.pump(uri).catch(() => {});
  }

  async finish(uri: string, signal: AbortSignal): Promise<string> {
    this.uri = uri;
    const stoppedAt = Date.now();
    let deadline = stoppedAt + SERVER_DEADLINE_MS;
    const dictationId = dictationIdFor(this.recordings, uri);
    let failures = 0;
    let incompleteRounds = 0;
    for (;;) {
      throwIfVoiceTranscriptionAborted(signal);
      try {
        const totalBytes = await this.pump(uri);
        deadline = Math.max(
          deadline,
          stoppedAt + SERVER_DEADLINE_MS + transcribeTimeoutMs(totalBytes),
        );
        const result = await withTimeout(
          this.transport.transcribe({
            dictationId,
            totalBytes,
            mimeType: this.mimeType,
            source: this.source,
            recordingMs: stoppedAt - this.startedAt,
            uploadAfterStopMs: Date.now() - stoppedAt,
          }),
          transcribeTimeoutMs(totalBytes),
        );
        throwIfVoiceTranscriptionAborted(signal);
        if (result._tag === "transcribed") return result.transcript;
        // The server is missing bytes it never got; send them again from where it stopped.
        this.sentBytes = result.receivedBytes;
        incompleteRounds += 1;
        if (incompleteRounds <= 3) continue;
      } catch (error) {
        if (
          error instanceof VoiceTranscriptionError ||
          error instanceof ServerDictationRejected ||
          error instanceof ServerDictationUnsupported
        ) {
          throw error;
        }
      }
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!;
      failures += 1;
      if (Date.now() + delay > deadline) throw new ServerDictationUnreachable();
      await waitFor(delay, signal);
    }
  }

  /** Sends every byte recorded so far and returns the recording's length. */
  private pump(uri: string): Promise<number> {
    const previous = this.pumping ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.sendPending(uri));
    const settled = next.then(
      () => {},
      () => {},
    );
    this.pumping = settled;
    void settled.then(() => {
      if (this.pumping === settled) this.pumping = null;
    });
    return next;
  }

  private async sendPending(uri: string): Promise<number> {
    const dictationId = dictationIdFor(this.recordings, uri);
    let stalls = 0;
    for (;;) {
      const offset = this.sentBytes;
      const { bytes, mimeType } = await this.read(uri, offset, MAX_CHUNK_BYTES);
      this.mimeType = mimeType;
      if (bytes.length === 0) return offset;
      const { receivedBytes } = await withTimeout(
        this.transport.append({ dictationId, offset, data: encodeBase64(bytes), mimeType }),
        APPEND_TIMEOUT_MS,
      );
      stalls = receivedBytes > offset ? 0 : stalls + 1;
      if (stalls > 2) throw new Error("The server is not taking the recording.");
      this.sentBytes = receivedBytes;
    }
  }
}

// The controller allows one dictation at a time, so the recorder streams into the active one.
let activeUpload: ServerDictationUpload | null = null;

/** Called by recorders as audio is written; sends it to the server at most once a second. */
export function streamRecordingAudio(uri: string): void {
  activeUpload?.stream(uri);
}

/**
 * Streams each recording to the server and transcribes it there. Without a server connection
 * (or on an older server) the recording goes to `fallback`, which uploads it to ElevenLabs
 * itself. The transcript is saved beside the audio, which lets the audio be deleted.
 */
export function createServerDictationTranscriber(options: {
  readonly transport: ServerDictationTransport | null;
  readonly read: RecordingAudioReader;
  readonly recordings: ElevenLabsRecordings;
  readonly source: "web" | "mobile";
  readonly locale: () => string;
  readonly fallback: VoiceTranscriber | null;
}): VoiceTranscriber {
  const { transport, recordings, fallback } = options;
  const transcribeWithFallback = async (uri: string, signal: AbortSignal, cause: Error) => {
    const serverFailure = new VoiceTranscriptionError(
      "transcription-failed",
      `${cause.message} ${recordings.failureHint}`,
    );
    if (!fallback) throw serverFailure;
    let prepared;
    try {
      prepared = await fallback.prepare({ signal });
    } catch (error) {
      // No way around the server (say, no key on this device): its failure is the one to show.
      if (error instanceof VoiceTranscriptionError && error.code === "unavailable") {
        throw serverFailure;
      }
      throw error;
    }
    return prepared.transcribe(uri, { signal });
  };

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      if (!transport) {
        if (!fallback) {
          throw new VoiceTranscriptionError("unavailable", recordings.missingKeyMessage);
        }
        return fallback.prepare({ signal });
      }
      const upload = new ServerDictationUpload(transport, options.read, recordings, options.source);
      activeUpload = upload;
      return {
        locale: options.locale(),
        transcribe: async (uri, { signal: transcribeSignal }) => {
          try {
            const transcript = await upload.finish(uri, transcribeSignal);
            // An empty result keeps the audio: a long recording with no words is more likely a
            // fault than silence.
            if (transcript.length > 0) await saveTranscript(recordings.storage, uri, transcript);
            return transcript;
          } catch (error) {
            if (error instanceof VoiceTranscriptionError) throw error;
            const fallsBack =
              error instanceof ServerDictationUnsupported ||
              error instanceof ServerDictationUnreachable ||
              (error instanceof ServerDictationRejected &&
                (error.reason === "missing-key" || error.reason === "unreachable"));
            if (fallsBack) return transcribeWithFallback(uri, transcribeSignal, error);
            throw new VoiceTranscriptionError(
              "transcription-failed",
              `${error instanceof Error ? error.message : "Could not transcribe this recording."} ${recordings.failureHint}`,
            );
          } finally {
            if (activeUpload === upload) activeUpload = null;
          }
        },
      };
    },
  };
}

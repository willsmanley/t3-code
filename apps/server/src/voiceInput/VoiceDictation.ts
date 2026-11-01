import {
  VoiceDictationError,
  type VoiceDictationAppendInput,
  type VoiceDictationTranscribeInput,
  type VoiceDictationTranscribeResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { readElevenLabsApiKey } from "./elevenLabsApiKey.ts";

// Fork (F16): clients stream dictation audio here while recording, so when the recording ends
// only its last second is still in flight and the server's fast link does the ElevenLabs upload.

const ELEVENLABS_SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_CHUNK_BASE64_LENGTH = 2 * 1024 * 1024;
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

/** Long enough for ElevenLabs to process twenty minutes of speech, short enough to retry a stall. */
const attemptTimeout = (bytes: number) => Duration.millis(30_000 + (bytes / 1_048_576) * 20_000);

type Timing = {
  readonly firstChunkAt: number;
  finishRequestedAt: number | null;
  missingBytesAtFinish: number | null;
  uploadAfterStopMs: number | null;
};

type Attempt =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "retry"; readonly status: number | null }
  | { readonly kind: "fail"; readonly error: VoiceDictationError };

export class VoiceDictation extends Context.Service<
  VoiceDictation,
  {
    readonly append: (
      input: VoiceDictationAppendInput,
    ) => Effect.Effect<{ readonly receivedBytes: number }, VoiceDictationError>;
    readonly transcribe: (
      input: VoiceDictationTranscribeInput,
    ) => Effect.Effect<VoiceDictationTranscribeResult, VoiceDictationError>;
  }
>()("t3/voiceInput/VoiceDictation") {}

function audioExtension(mimeType: string): string {
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

const decodeTranscript = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);
const encodeLogLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function parseTranscript(body: string): string {
  return Option.match(decodeTranscript(body), {
    onNone: () => "",
    onSome: ({ text }) => text.trim(),
  });
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const directory = path.join(config.stateDir, "voice-dictation");
  const logPath = path.join(config.logsDir, "voice-dictation.ndjson");
  const fileLock = yield* Semaphore.make(1);
  const transcribeLocks = new Map<string, Semaphore.Semaphore>();
  const timings = new Map<string, Timing>();
  let lastPruneAt = 0;

  const audioPath = (id: string) => path.join(directory, `${id}.audio`);
  const transcriptPath = (id: string) => path.join(directory, `${id}.txt`);
  const storageError = () => new VoiceDictationError({ reason: "storage" });

  const sizeOf = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

  const readTranscript = (id: string) =>
    fileSystem.readFileString(transcriptPath(id)).pipe(
      Effect.map((text): string | null => text),
      Effect.orElseSucceed(() => null),
    );

  const writeLog = Effect.fn("VoiceDictation.writeLog")(function* (entry: Record<string, unknown>) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* fileSystem.makeDirectory(config.logsDir, { recursive: true });
    yield* fileSystem.writeFileString(logPath, `${encodeLogLine({ at, ...entry })}\n`, {
      flag: "a",
    });
  }, Effect.ignore);

  // Transcripts stay a week so a client that lost its connection can still collect one.
  const pruneOldFiles = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now;
    for (const [id, timing] of timings) {
      if (now - timing.firstChunkAt > RETENTION_MS) {
        timings.delete(id);
        transcribeLocks.delete(id);
      }
    }
    const names = yield* fileSystem.readDirectory(directory);
    for (const name of names) {
      const file = path.join(directory, name);
      const info = yield* fileSystem.stat(file);
      const modifiedAt = Option.match(info.mtime, {
        onNone: () => now,
        onSome: (date) => date.getTime(),
      });
      if (now - modifiedAt > RETENTION_MS) yield* fileSystem.remove(file);
    }
  }).pipe(Effect.ignore);

  const append = Effect.fn("VoiceDictation.append")(function* (input: VoiceDictationAppendInput) {
    if (input.data.length > MAX_CHUNK_BASE64_LENGTH) {
      return yield* new VoiceDictationError({ reason: "too-large" });
    }
    const bytes = Uint8Array.from(Buffer.from(input.data, "base64"));
    return yield* fileLock.withPermits(1)(
      Effect.gen(function* () {
        const file = audioPath(input.dictationId);
        const size = yield* sizeOf(file);
        if (!timings.has(input.dictationId)) {
          timings.set(input.dictationId, {
            firstChunkAt: yield* Clock.currentTimeMillis,
            finishRequestedAt: null,
            missingBytesAtFinish: null,
            uploadAfterStopMs: null,
          });
        }
        // A gap means an earlier chunk was lost: report what arrived so the client resends it.
        if (input.offset > size) return { receivedBytes: size };
        const fresh = bytes.subarray(size - input.offset);
        if (fresh.length === 0) return { receivedBytes: size };
        if (size + fresh.length > MAX_RECORDING_BYTES) {
          return yield* new VoiceDictationError({ reason: "too-large" });
        }
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFile(file, fresh, { flag: "a" });
        return { receivedBytes: size + fresh.length };
      }).pipe(Effect.catchTags({ PlatformError: () => Effect.fail(storageError()) })),
    );
  });

  const requestTranscript = Effect.fn("VoiceDictation.requestTranscript")(
    function* (apiKey: string, audio: Uint8Array, mimeType: string) {
      const form = new FormData();
      form.append("model_id", "scribe_v2");
      form.append("tag_audio_events", "false");
      form.append(
        "file",
        new Blob([audio], { type: mimeType }),
        `recording.${audioExtension(mimeType)}`,
      );
      const response = yield* httpClient.execute(
        HttpClientRequest.post(ELEVENLABS_SPEECH_TO_TEXT_URL).pipe(
          HttpClientRequest.setHeader("xi-api-key", apiKey),
          HttpClientRequest.bodyFormData(form),
        ),
      );
      const body = yield* response.text;
      return { status: response.status, body };
    },
    (effect, _apiKey, audio) => effect.pipe(Effect.timeout(attemptTimeout(audio.length))),
  );

  const attemptTranscript = (apiKey: string, audio: Uint8Array, mimeType: string) =>
    requestTranscript(apiKey, audio, mimeType).pipe(
      Effect.map(({ status, body }): Attempt => {
        if (status >= 200 && status < 300) return { kind: "ok", text: parseTranscript(body) };
        if (status === 408 || status === 429 || status >= 500) return { kind: "retry", status };
        // ElevenLabs answers an exhausted quota with the same 401 as a bad key.
        if (body.includes('"quota_exceeded"')) {
          return { kind: "fail", error: new VoiceDictationError({ reason: "out-of-credits" }) };
        }
        if (status === 401) {
          return { kind: "fail", error: new VoiceDictationError({ reason: "rejected-key" }) };
        }
        return {
          kind: "fail",
          error: new VoiceDictationError({ reason: "transcription-failed", status }),
        };
      }),
      Effect.orElseSucceed((): Attempt => ({ kind: "retry", status: null })),
    );

  const runTranscription = Effect.fn("VoiceDictation.runTranscription")(function* (
    input: VoiceDictationTranscribeInput,
    audio: Uint8Array,
  ) {
    const { apiKey } = yield* readElevenLabsApiKey(secretStore);
    if (!apiKey) return yield* new VoiceDictationError({ reason: "missing-key" });
    const startedAt = yield* Clock.currentTimeMillis;
    let attempts = 0;
    let lastStatus: number | null = null;
    while (true) {
      attempts += 1;
      const attempt = yield* attemptTranscript(apiKey, audio, input.mimeType);
      if (attempt.kind === "ok") {
        return {
          text: attempt.text,
          attempts,
          elevenLabsMs: (yield* Clock.currentTimeMillis) - startedAt,
        };
      }
      if (attempt.kind === "fail") {
        yield* logFailure(input, attempts, attempt.error, startedAt);
        return yield* attempt.error;
      }
      lastStatus = attempt.status;
      const delay = RETRY_DELAYS_MS[attempts - 1];
      if (delay === undefined) {
        const error =
          lastStatus === null
            ? new VoiceDictationError({ reason: "unreachable" })
            : new VoiceDictationError({ reason: "transcription-failed", status: lastStatus });
        yield* logFailure(input, attempts, error, startedAt);
        return yield* error;
      }
      yield* Effect.sleep(Duration.millis(delay));
    }
  });

  const logFailure = Effect.fn("VoiceDictation.logFailure")(function* (
    input: VoiceDictationTranscribeInput,
    attempts: number,
    error: VoiceDictationError,
    startedAt: number,
  ) {
    yield* writeLog({
      event: "failed",
      dictationId: input.dictationId,
      source: input.source,
      bytes: input.totalBytes,
      recordingMs: input.recordingMs ?? null,
      attempts,
      reason: error.reason,
      status: error.status ?? null,
      elevenLabsMs: (yield* Clock.currentTimeMillis) - startedAt,
    });
  });

  const transcribeLocked = Effect.fn("VoiceDictation.transcribeLocked")(function* (
    input: VoiceDictationTranscribeInput,
  ) {
    const id = input.dictationId;
    const cached = yield* readTranscript(id);
    if (cached !== null) return { _tag: "transcribed" as const, transcript: cached };

    const now = yield* Clock.currentTimeMillis;
    const timing = timings.get(id) ?? {
      firstChunkAt: now,
      finishRequestedAt: null,
      missingBytesAtFinish: null,
      uploadAfterStopMs: null,
    };
    timings.set(id, timing);
    const received = yield* fileLock.withPermits(1)(sizeOf(audioPath(id)));
    if (timing.finishRequestedAt === null) {
      timing.finishRequestedAt = now;
      timing.missingBytesAtFinish = Math.max(0, input.totalBytes - received);
      timing.uploadAfterStopMs = input.uploadAfterStopMs ?? null;
    }
    if (received < input.totalBytes) {
      return { _tag: "incomplete" as const, receivedBytes: received };
    }

    const audio =
      input.totalBytes === 0
        ? new Uint8Array()
        : (yield* fileSystem.readFile(audioPath(id))).subarray(0, input.totalBytes);
    const result =
      audio.length === 0
        ? { text: "", attempts: 0, elevenLabsMs: 0 }
        : yield* runTranscription(input, audio);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(transcriptPath(id), result.text);
    yield* fileSystem.remove(audioPath(id)).pipe(Effect.ignore);
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* writeLog({
      event: "transcribed",
      dictationId: id,
      source: input.source,
      mimeType: input.mimeType,
      bytes: input.totalBytes,
      recordingMs: input.recordingMs ?? null,
      uploadAfterStopMs: timing.uploadAfterStopMs,
      bytesMissingAtTranscribe: timing.missingBytesAtFinish,
      transcribeMs: finishedAt - (timing.finishRequestedAt ?? finishedAt),
      elevenLabsMs: result.elevenLabsMs,
      attempts: result.attempts,
      words: result.text.length === 0 ? 0 : result.text.split(/\s+/).length,
    });
    timings.delete(id);
    return { _tag: "transcribed" as const, transcript: result.text };
  });

  const transcribe = Effect.fn("VoiceDictation.transcribe")(function* (
    input: VoiceDictationTranscribeInput,
  ) {
    yield* pruneOldFiles;
    let lock = transcribeLocks.get(input.dictationId);
    if (!lock) {
      lock = yield* Semaphore.make(1);
      transcribeLocks.set(input.dictationId, lock);
    }
    // A client that reconnects asks again; the second call waits and reads the saved transcript.
    const result = yield* lock
      .withPermits(1)(transcribeLocked(input))
      .pipe(Effect.catchTags({ PlatformError: () => Effect.fail(storageError()) }));
    if (result._tag === "transcribed") transcribeLocks.delete(input.dictationId);
    return result;
  });

  return VoiceDictation.of({ append, transcribe });
});

export const layer = Layer.effect(VoiceDictation, make);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VoiceDictation from "./VoiceDictation.ts";

const base64 = (text: string) => Buffer.from(text).toString("base64");
const chunk = (offset: number, text: string) => ({
  dictationId: "rec-1",
  offset,
  data: base64(text),
  mimeType: "audio/aac",
});
const finish = (totalBytes: number) => ({
  dictationId: "rec-1",
  totalBytes,
  mimeType: "audio/aac",
  source: "mobile" as const,
  recordingMs: 4_000,
});

const withDictation = <A, E>(
  options: {
    readonly apiKey: string | null;
    readonly responses: Response[];
    readonly requests: HttpClientRequest.HttpClientRequest[];
  },
  body: Effect.Effect<
    A,
    E,
    VoiceDictation.VoiceDictation | ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-voice-dictation-" });
    const http = HttpClient.make((request) => {
      options.requests.push(request);
      const response = options.responses.shift();
      return response
        ? Effect.succeed(HttpClientResponse.fromWeb(request, response))
        : Effect.die("unexpected request");
    });
    return yield* body.pipe(
      Effect.provide(
        VoiceDictation.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: (name) =>
                Effect.succeed(
                  name === "elevenlabs-api-key" && options.apiKey !== null
                    ? Option.some(new TextEncoder().encode(options.apiKey))
                    : Option.none(),
                ),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("VoiceDictation", (it) => {
  it.effect("stores streamed audio once, skipping resent bytes and reporting gaps", () =>
    withDictation(
      { apiKey: "sk_test", responses: [], requests: [] },
      Effect.gen(function* () {
        const dictation = yield* VoiceDictation.VoiceDictation;
        assert.deepStrictEqual(yield* dictation.append(chunk(0, "abc")), { receivedBytes: 3 });
        assert.deepStrictEqual(yield* dictation.append(chunk(3, "def")), { receivedBytes: 6 });
        assert.deepStrictEqual(yield* dictation.append(chunk(3, "def")), { receivedBytes: 6 });
        assert.deepStrictEqual(yield* dictation.append(chunk(10, "xyz")), { receivedBytes: 6 });
        assert.deepStrictEqual(yield* dictation.append(chunk(4, "efgh")), { receivedBytes: 8 });

        const { stateDir } = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const stored = yield* fs.readFileString(
          path.join(stateDir, "voice-dictation", "rec-1.audio"),
        );
        assert.equal(stored, "abcdefgh");
      }),
    ),
  );

  it.effect("waits for missing bytes, then transcribes once and keeps the transcript", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return withDictation(
      { apiKey: "sk_test", responses: [Response.json({ text: " Hello there. " })], requests },
      Effect.gen(function* () {
        const dictation = yield* VoiceDictation.VoiceDictation;
        yield* dictation.append(chunk(0, "abcdef"));
        assert.deepStrictEqual(yield* dictation.transcribe(finish(8)), {
          _tag: "incomplete",
          receivedBytes: 6,
        });
        yield* dictation.append(chunk(6, "gh"));
        const expected = { _tag: "transcribed" as const, transcript: "Hello there." };
        assert.deepStrictEqual(yield* dictation.transcribe(finish(8)), expected);
        assert.deepStrictEqual(yield* dictation.transcribe(finish(8)), expected);

        assert.equal(requests.length, 1);
        const request = requests[0]!;
        assert.equal(request.url, "https://api.elevenlabs.io/v1/speech-to-text");
        assert.equal(request.headers["xi-api-key"], "sk_test");
        if (request.body._tag !== "FormData") throw new Error("Expected a multipart upload");
        assert.equal(request.body.formData.get("model_id"), "scribe_v2");
        const file = request.body.formData.get("file");
        if (!(file instanceof Blob)) throw new Error("Expected the audio file");
        assert.equal(yield* Effect.promise(() => file.text()), "abcdefgh");

        const { stateDir, logsDir } = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(path.join(stateDir, "voice-dictation", "rec-1.audio")));
        const log = yield* fs.readFileString(path.join(logsDir, "voice-dictation.ndjson"));
        assert.deepInclude(JSON.parse(log.trim()), {
          event: "transcribed",
          source: "mobile",
          bytes: 8,
          bytesMissingAtTranscribe: 2,
          attempts: 1,
          words: 2,
        });
      }),
    );
  });

  it.effect("fails without a key and on an exhausted quota, keeping the audio", () =>
    Effect.gen(function* () {
      const missingKey = yield* withDictation(
        { apiKey: null, responses: [], requests: [] },
        Effect.gen(function* () {
          const dictation = yield* VoiceDictation.VoiceDictation;
          yield* dictation.append(chunk(0, "abc"));
          return yield* Effect.flip(dictation.transcribe(finish(3)));
        }),
      );
      assert.equal(missingKey.reason, "missing-key");

      const quota = yield* withDictation(
        {
          apiKey: "sk_test",
          responses: [Response.json({ detail: { status: "quota_exceeded" } }, { status: 401 })],
          requests: [],
        },
        Effect.gen(function* () {
          const dictation = yield* VoiceDictation.VoiceDictation;
          yield* dictation.append(chunk(0, "abc"));
          const error = yield* Effect.flip(dictation.transcribe(finish(3)));
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          assert.isTrue(yield* fs.exists(path.join(stateDir, "voice-dictation", "rec-1.audio")));
          return error;
        }),
      );
      assert.equal(quota.reason, "out-of-credits");
    }),
  );
});

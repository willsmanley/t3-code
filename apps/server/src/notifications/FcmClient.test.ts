// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or verify.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as FcmClient from "./FcmClient.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const account = {
  project_id: "fork-project",
  client_email: "push@fork-project.iam.gserviceaccount.com",
  private_key: privateKey,
};
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const input = {
  account,
  token: "device-token",
  packageName: "com.example.t3code",
  data: { t3_kind: "agent_activity", active: "true" },
  alert: false,
};

function layerTest(requests: HttpClientRequest.HttpClientRequest[], responses: Response[]) {
  const http = HttpClient.make((request) => {
    requests.push(request);
    const response = responses.shift();
    return response
      ? Effect.succeed(HttpClientResponse.fromWeb(request, response))
      : Effect.die("unexpected request");
  });
  return FcmClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
}

const fcmError = (status: number, details: ReadonlyArray<unknown>) =>
  Response.json({ error: { status: "INVALID_ARGUMENT", details } }, { status });

describe("FcmClient", () => {
  it.effect("authorizes with a verifiable assertion and reuses the access token", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient.FcmClient;
      assert.equal(yield* client.send(input), "sent");
      assert.equal(yield* client.send({ ...input, alert: true }), "sent");
      assert.deepEqual(
        requests.map((request) => request.url),
        [
          "https://oauth2.googleapis.com/token",
          "https://fcm.googleapis.com/v1/projects/fork-project/messages:send",
          "https://fcm.googleapis.com/v1/projects/fork-project/messages:send",
        ],
      );
      const tokenBody = requests[0]!.body;
      if (tokenBody._tag !== "Uint8Array") throw new Error("Expected an encoded token request");
      const assertion = new URLSearchParams(new TextDecoder().decode(tokenBody.body)).get(
        "assertion",
      );
      const [header, claims, signature] = (assertion ?? "").split(".");
      assert.isTrue(
        NodeCrypto.verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      );
      assert.deepInclude(decodeJson(Buffer.from(claims!, "base64url").toString()), {
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
      });
      assert.equal(requests[1]!.headers.authorization, "Bearer access-token");
      const decodeBody = (request: HttpClientRequest.HttpClientRequest) => {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected an encoded FCM body");
        return decodeJson(new TextDecoder().decode(request.body.body));
      };
      assert.deepEqual(decodeBody(requests[1]!), {
        message: {
          token: input.token,
          data: input.data,
          android: {
            priority: "HIGH",
            ttl: "300s",
            collapse_key: "t3-agent-activity",
            restricted_package_name: input.packageName,
          },
        },
      });
      assert.notProperty(
        (decodeBody(requests[2]!) as { message: { android: object } }).message.android,
        "collapse_key",
      );
    }).pipe(
      Effect.provide(
        layerTest(requests, [
          Response.json({ access_token: "access-token" }),
          Response.json({ name: "one" }),
          Response.json({ name: "two" }),
        ]),
      ),
    );
  });

  it.effect("mints a new access token once the cached one ages out", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient.FcmClient;
      yield* client.send(input);
      yield* TestClock.adjust("51 minutes");
      yield* client.send(input);
      assert.equal(requests[3]!.headers.authorization, "Bearer second-token");
    }).pipe(
      Effect.provide(
        layerTest(requests, [
          Response.json({ access_token: "first-token" }),
          Response.json({ name: "one" }),
          Response.json({ access_token: "second-token" }),
          Response.json({ name: "two" }),
        ]),
      ),
    );
  });

  it.effect("reports tokens Firebase will never deliver to", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient.FcmClient;
      assert.equal(yield* client.send(input), "invalid-token");
      assert.equal(yield* client.send(input), "invalid-token");
      assert.equal(yield* client.send(input), "invalid-token");
    }).pipe(
      Effect.provide(
        layerTest(requests, [
          Response.json({ access_token: "access-token" }),
          fcmError(404, [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ]),
          fcmError(400, [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "INVALID_ARGUMENT",
            },
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [{ field: "message.token" }],
            },
          ]),
          fcmError(403, [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "SENDER_ID_MISMATCH",
            },
          ]),
        ]),
      ),
    );
  });

  it.effect("keeps the device for payload errors and marks outages retryable", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient.FcmClient;
      const payload = yield* client.send(input).pipe(Effect.flip);
      assert.deepInclude(payload, { stage: "send", status: 400, retryable: false });
      const outage = yield* client.send(input).pipe(Effect.flip);
      assert.deepInclude(outage, { status: 503, retryable: true });
      const expired = yield* client.send(input).pipe(Effect.flip);
      assert.deepInclude(expired, { status: 401, retryable: true });
      yield* client.send(input);
      assert.equal(requests[4]!.url, "https://oauth2.googleapis.com/token");
      assert.equal(requests[5]!.headers.authorization, "Bearer fresh-token");
    }).pipe(
      Effect.provide(
        layerTest(requests, [
          Response.json({ access_token: "old-token" }),
          fcmError(400, [
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [{ field: "message.data" }],
            },
          ]),
          Response.json({}, { status: 503 }),
          Response.json({}, { status: 401 }),
          Response.json({ access_token: "fresh-token" }),
          Response.json({ name: "sent" }),
        ]),
      ),
    );
  });

  it.effect("rejects oversized data before contacting Firebase", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* FcmClient.FcmClient;
      const error = yield* client
        .send({ ...input, data: { body: "漢".repeat(1500) } })
        .pipe(Effect.flip);
      assert.isFalse(error.retryable);
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(layerTest(requests, [])));
  });

  it.effect("treats a malformed service account as unconfigured", () =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
        set: () => Effect.die("unused"),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      });
      assert.isTrue(Option.isNone(yield* FcmClient.readFcmServiceAccount(secrets)));
      values.set(FcmClient.FCM_SERVICE_ACCOUNT_SECRET, new TextEncoder().encode("{not json"));
      assert.isTrue(Option.isNone(yield* FcmClient.readFcmServiceAccount(secrets)));
      values.set(
        FcmClient.FCM_SERVICE_ACCOUNT_SECRET,
        new TextEncoder().encode(JSON.stringify({ ...account, type: "service_account" })),
      );
      const decoded = yield* FcmClient.readFcmServiceAccount(secrets);
      assert.equal(Option.getOrNull(decoded)?.project_id, "fork-project");
    }),
  );
});

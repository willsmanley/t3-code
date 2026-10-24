import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** A Firebase service-account key JSON; placing it turns on direct Android push. */
export const FCM_SERVICE_ACCOUNT_SECRET = "fcm-service-account";

const FCM_HTTP_STAGE_TIMEOUT = "10 seconds";
// Google issues hour-long tokens; refreshing early keeps a slow send from
// presenting one that expires in flight.
const ACCESS_TOKEN_LIFETIME_MS = 50 * 60 * 1_000;
const FCM_DATA_LIMIT_BYTES = 4_096;

const FcmServiceAccount = Schema.Struct({
  // Advertised to clients, which only register when it matches their own project.
  project_id: TrimmedNonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});
export type FcmServiceAccount = typeof FcmServiceAccount.Type;
const decodeServiceAccount = Schema.decodeUnknownOption(Schema.fromJsonString(FcmServiceAccount));
const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.NonEmptyString }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFcmError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({
      status: Schema.optional(Schema.String),
      details: Schema.optional(
        Schema.Array(
          Schema.Struct({
            "@type": Schema.optional(Schema.String),
            errorCode: Schema.optional(Schema.String),
            fieldViolations: Schema.optional(
              Schema.Array(Schema.Struct({ field: Schema.optional(Schema.String) })),
            ),
          }),
        ),
      ),
    }),
  }),
);

/** Never fails: a missing, unreadable or malformed key leaves direct push off. */
export const readFcmServiceAccount = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<Option.Option<FcmServiceAccount>> =>
  secrets.get(FCM_SERVICE_ACCOUNT_SECRET).pipe(
    Effect.map(Option.flatMap((bytes) => decodeServiceAccount(new TextDecoder().decode(bytes)))),
    Effect.orElseSucceed(() => Option.none<FcmServiceAccount>()),
  );

export class FcmSendError extends Schema.TaggedError<FcmSendError>()("FcmSendError", {
  stage: Schema.Literals(["authorize", "send"]),
  status: Schema.NullOr(Schema.Number),
  /** Rate limits, outages and expired authorization can succeed later; bad requests cannot. */
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `FCM ${this.stage} failed${this.status === null ? "" : ` (${this.status})`}.`;
  }
}

/**
 * `invalid-token` means Firebase will never deliver to this token again: the
 * app was uninstalled, the token was malformed, or it belongs to another
 * Firebase project.
 */
export type FcmSendResult = "sent" | "invalid-token";

export class FcmClient extends Context.Service<
  FcmClient,
  {
    readonly send: (input: {
      readonly account: FcmServiceAccount;
      readonly token: string;
      readonly packageName: string;
      readonly data: Readonly<Record<string, string>>;
      readonly alert: boolean;
    }) => Effect.Effect<FcmSendResult, FcmSendError>;
  }
>()("t3/notifications/FcmClient") {}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const signAssertion = (account: FcmServiceAccount, issuedAt: number) =>
  Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder();
      const header = base64Url(encoder.encode(encodeJson({ alg: "RS256", typ: "JWT" })));
      const claims = base64Url(
        encoder.encode(
          encodeJson({
            iss: account.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token",
            iat: issuedAt,
            exp: issuedAt + 3600,
          }),
        ),
      );
      const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
      const key = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await globalThis.crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(`${header}.${claims}`),
      );
      return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
    },
    catch: (cause) =>
      new FcmSendError({ stage: "authorize", status: null, retryable: false, cause }),
  });

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

function classifyFcmError(body: unknown): "invalid-token" | null {
  const decoded = decodeFcmError(body);
  if (Option.isNone(decoded)) return null;
  const details = decoded.value.error.details ?? [];
  const errorCode = details.find(
    (detail) => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  )?.errorCode;
  if (errorCode === "UNREGISTERED" || errorCode === "SENDER_ID_MISMATCH") return "invalid-token";
  // INVALID_ARGUMENT also covers payload problems; only a violation on the
  // token field says the registration itself is unusable.
  const invalidArgument =
    errorCode === "INVALID_ARGUMENT" || decoded.value.error.status === "INVALID_ARGUMENT";
  const tokenViolation = details.some((detail) =>
    detail.fieldViolations?.some((violation) => violation.field === "message.token"),
  );
  return invalidArgument && tokenViolation ? "invalid-token" : null;
}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const cachedToken = yield* Ref.make<{
    readonly account: FcmServiceAccount;
    readonly accessToken: string;
    readonly expiresAtMs: number;
  } | null>(null);

  const sameAccount = (left: FcmServiceAccount, right: FcmServiceAccount) =>
    left.project_id === right.project_id &&
    left.client_email === right.client_email &&
    left.private_key === right.private_key;

  const authorize = Effect.fn("FcmClient.authorize")(function* (account: FcmServiceAccount) {
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const cached = yield* Ref.get(cachedToken);
    if (cached && sameAccount(cached.account, account) && nowMs < cached.expiresAtMs) {
      return cached.accessToken;
    }
    const assertion = yield* signAssertion(account, Math.floor(nowMs / 1_000));
    const response = yield* client
      .execute(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
        ),
      )
      .pipe(
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) => new FcmSendError({ stage: "authorize", status: null, retryable: true, cause }),
        ),
      );
    if (response.status !== 200) {
      return yield* new FcmSendError({
        stage: "authorize",
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }
    const accessToken = yield* response.json.pipe(
      Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
      Effect.flatMap(decodeAccessToken),
      Effect.map((body) => body.access_token),
      Effect.mapError(
        (cause) =>
          new FcmSendError({ stage: "authorize", status: response.status, retryable: true, cause }),
      ),
    );
    yield* Ref.set(cachedToken, {
      account,
      accessToken,
      expiresAtMs: nowMs + ACCESS_TOKEN_LIFETIME_MS,
    });
    return accessToken;
  });

  return FcmClient.of({
    send: Effect.fn("FcmClient.send")(function* (input) {
      if (new TextEncoder().encode(encodeJson(input.data)).length > FCM_DATA_LIMIT_BYTES) {
        return yield* new FcmSendError({ stage: "send", status: null, retryable: false });
      }
      const accessToken = yield* authorize(input.account);
      const response = yield* HttpClientRequest.post(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(input.account.project_id)}/messages:send`,
      ).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.bodyJson({
          message: {
            token: input.token,
            data: input.data,
            android: {
              priority: "HIGH",
              ttl: "300s",
              // Activity updates replace each other while the phone is
              // offline; alerts must each arrive.
              ...(!input.alert ? { collapse_key: "t3-agent-activity" } : {}),
              restricted_package_name: input.packageName,
            },
          },
        }),
        Effect.flatMap(client.execute),
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) => new FcmSendError({ stage: "send", status: null, retryable: true, cause }),
        ),
      );
      if (response.status >= 200 && response.status < 300) return "sent" as const;
      if (response.status === 401) yield* Ref.set(cachedToken, null);
      const body = yield* response.json.pipe(
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.orElseSucceed(() => null),
      );
      if (classifyFcmError(body) === "invalid-token") return "invalid-token" as const;
      return yield* new FcmSendError({
        stage: "send",
        status: response.status,
        retryable: isRetryableStatus(response.status),
      });
    }),
  });
});

export const layer = Layer.effect(FcmClient, make);

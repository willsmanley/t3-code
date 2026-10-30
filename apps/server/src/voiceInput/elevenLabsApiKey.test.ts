import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SecretStoreReadError } from "../auth/ServerSecretStore.ts";
import { readElevenLabsApiKey } from "./elevenLabsApiKey.ts";

const storeWith = (stored: Option.Option<string>) => ({
  get: (name: string) =>
    Effect.succeed(
      name === "elevenlabs-api-key"
        ? Option.map(stored, (key) => new TextEncoder().encode(key))
        : Option.none(),
    ),
});

it.effect("returns the saved key without surrounding whitespace", () =>
  Effect.gen(function* () {
    const result = yield* readElevenLabsApiKey(storeWith(Option.some("sk_test\n")));
    assert.deepStrictEqual(result, { apiKey: "sk_test" });
  }),
);

it.effect("returns null when no key or a blank key is saved", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* readElevenLabsApiKey(storeWith(Option.none())), { apiKey: null });
    assert.deepStrictEqual(yield* readElevenLabsApiKey(storeWith(Option.some("  "))), {
      apiKey: null,
    });
  }),
);

it.effect("returns null when the secret store cannot be read", () =>
  Effect.gen(function* () {
    const result = yield* readElevenLabsApiKey({
      get: (name) => Effect.fail(new SecretStoreReadError({ resource: name, cause: "denied" })),
    });
    assert.deepStrictEqual(result, { apiKey: null });
  }),
);

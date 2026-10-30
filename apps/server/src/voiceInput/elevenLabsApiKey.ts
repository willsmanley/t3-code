import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

// Fork (F14): web and desktop voice input transcribe with this server's ElevenLabs key, so it is
// saved once per server (`<base-dir>/userdata/secrets/elevenlabs-api-key.bin`), not per browser.
const ELEVENLABS_API_KEY_SECRET_NAME = "elevenlabs-api-key";

/** The saved key, read on each request so a new key works without a restart. */
export const readElevenLabsApiKey = (
  secretStore: Pick<ServerSecretStore.ServerSecretStore["Service"], "get">,
) =>
  secretStore.get(ELEVENLABS_API_KEY_SECRET_NAME).pipe(
    Effect.map((stored) =>
      Option.match(stored, {
        onNone: () => null,
        onSome: (bytes) => new TextDecoder().decode(bytes).trim() || null,
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read the ElevenLabs API key.", { cause }).pipe(Effect.as(null)),
    ),
    Effect.map((apiKey) => ({ apiKey })),
  );

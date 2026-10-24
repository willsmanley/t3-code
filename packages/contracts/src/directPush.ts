import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RelayAgentAwarenessPreferences } from "./relay.ts";

/**
 * The native Android handler drops pushes whose user id differs from the one it
 * was configured with. Direct pushes have no T3 Connect account behind them, so
 * the app and server agree on this fixed id instead.
 */
export const DIRECT_PUSH_NOTIFICATION_USER_ID = "direct-push";

export const DirectPushDeviceRegistrationInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  pushToken: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  /** Android application id, used as FCM's restricted package name. */
  packageName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  preferences: RelayAgentAwarenessPreferences,
});
export type DirectPushDeviceRegistrationInput = typeof DirectPushDeviceRegistrationInput.Type;

export const DirectPushDeviceUnregistrationInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /**
   * Only the phone holds its FCM token, so presenting it lets a new pairing of
   * the same phone remove a registration an older pairing made.
   */
  pushToken: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
});
export type DirectPushDeviceUnregistrationInput = typeof DirectPushDeviceUnregistrationInput.Type;

export class DirectPushUnavailableError extends Schema.TaggedError<DirectPushUnavailableError>()(
  "DirectPushUnavailableError",
  {},
) {
  override get message(): string {
    return "This server is not configured to send push notifications.";
  }
}

export class DirectPushDeviceNotOwnedError extends Schema.TaggedError<DirectPushDeviceNotOwnedError>()(
  "DirectPushDeviceNotOwnedError",
  {},
) {
  override get message(): string {
    return "Another client on this server registered this device.";
  }
}

export class DirectPushRegistrationError extends Schema.TaggedError<DirectPushRegistrationError>()(
  "DirectPushRegistrationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "This server could not save the device's push registration.";
  }
}

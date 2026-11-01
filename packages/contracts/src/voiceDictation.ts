import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

// Fork (F16): clients stream dictation audio to their server while recording, and the server
// transcribes it with ElevenLabs once the recording ends.

export const VoiceDictationId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

export const VoiceDictationAppendInput = Schema.Struct({
  dictationId: VoiceDictationId,
  /** Where `data` starts in the recording. */
  offset: NonNegativeInt,
  /** Base64 audio bytes. */
  data: Schema.String,
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
});
export type VoiceDictationAppendInput = typeof VoiceDictationAppendInput.Type;

/** How many bytes of the recording the server holds; the client resends from there. */
export const VoiceDictationAppendResult = Schema.Struct({ receivedBytes: NonNegativeInt });

export const VoiceDictationTranscribeInput = Schema.Struct({
  dictationId: VoiceDictationId,
  totalBytes: NonNegativeInt,
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
  source: Schema.Literals(["web", "mobile"]),
  recordingMs: Schema.optional(NonNegativeInt),
  /** How long the client spent sending the rest of the audio after the recording stopped. */
  uploadAfterStopMs: Schema.optional(NonNegativeInt),
});
export type VoiceDictationTranscribeInput = typeof VoiceDictationTranscribeInput.Type;

export const VoiceDictationTranscribeResult = Schema.Union([
  Schema.TaggedStruct("incomplete", { receivedBytes: NonNegativeInt }),
  Schema.TaggedStruct("transcribed", { transcript: Schema.String }),
]);
export type VoiceDictationTranscribeResult = typeof VoiceDictationTranscribeResult.Type;

export class VoiceDictationError extends Schema.TaggedError<VoiceDictationError>()(
  "VoiceDictationError",
  {
    reason: Schema.Literals([
      "missing-key",
      "rejected-key",
      "out-of-credits",
      "transcription-failed",
      "unreachable",
      "too-large",
      "storage",
    ]),
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing-key":
        return "Voice input needs an ElevenLabs API key saved on the server.";
      case "rejected-key":
        return "ElevenLabs rejected the server's API key.";
      case "out-of-credits":
        return "ElevenLabs is out of credits.";
      case "transcription-failed":
        return `ElevenLabs could not transcribe this recording (error ${this.status ?? "unknown"}).`;
      case "unreachable":
        return "The server could not reach ElevenLabs.";
      case "too-large":
        return "This recording is too long to transcribe.";
      case "storage":
        return "The server could not save this recording.";
    }
  }
}

import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

import { getElevenLabsTranscriber } from "../features/voice-input/elevenLabsTranscription";

// Android has no on-device transcriber, so the fork sends recordings to ElevenLabs.
export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return getElevenLabsTranscriber();
}

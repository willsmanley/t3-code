import { requireOptionalNativeModule } from "expo";
import type { RecorderState, RecordingStatus } from "expo-audio";

import type { NativeVoiceRecorder } from "../features/voice-input/lazyVoiceRecorder";

// Fork (F8): Android's MediaRecorder drops the last ~170 ms when it stops, often a syllable. This
// recorder (modules/t3-fork-aac-recorder) writes the same ADTS AAC and keeps the whole ending.
type ForkAacRecorderModule = {
  readonly AacVoiceRecorder: new () => NativeVoiceRecorder<RecordingStatus, RecorderState>;
};

const native = requireOptionalNativeModule<ForkAacRecorderModule>("T3ForkAacRecorder");

/** Null on iOS, which has no such module. */
export function createForkAacRecorder() {
  return native ? new native.AacVoiceRecorder() : null;
}

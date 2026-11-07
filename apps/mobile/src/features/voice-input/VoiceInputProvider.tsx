import { useAtomValue } from "@effect/atom-react";
import { AudioModule, RecordingPresets, type RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { createVoiceRecorder } from "../../native/voiceRecorder";
import { createForkAacRecorder } from "../../native/forkAacRecorder";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  pruneSavedTranscripts,
  releaseRecording,
  streamRecordingAudio,
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { androidVoiceTranscriber } from "./elevenLabsTranscription";
import { androidRecordings } from "./savedRecordings";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import { voiceRouteAtom } from "./voiceDestination";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS } = RecordingPresets.HIGH_QUALITY;
// Android uploads its recordings, so it keeps them in document storage as
// ADTS AAC: unlike an MP4 container, a file cut off by a crash still plays.
const VOICE_RECORDING_OPTIONS =
  Platform.OS === "ios"
    ? {
        extension: RecordingPresets.HIGH_QUALITY.extension,
        sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
        numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
        bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
        isMeteringEnabled: true,
        ...IOS_RECORDING_OPTIONS,
      }
    : {
        extension: ".aac",
        // Transcribes as well as 44.1 kHz at 96 kbps in half the bytes (fork F16).
        sampleRate: 16_000,
        numberOfChannels: 1,
        bitRate: 48_000,
        isMeteringEnabled: true,
        outputFormat: "aac_adts",
        audioEncoder: "aac",
        directory: "document" as const,
      };
// Android recordings are uploaded, so they are not bound by on-device limits.
const RECORDING_LIMIT_SECONDS = Platform.OS === "android" ? 20 * 60 : VOICE_RECORDING_LIMIT_SECONDS;

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  // Fork (F8, F16): Android dictates through the thread's server and ElevenLabs, not Google's
  // on-device model; upstream's voiceTranscription.android.ts stays unused there.
  read: () =>
    Platform.OS === "android"
      ? Promise.resolve(androidVoiceTranscriber)
      : getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);

const voiceInputAvailableAtom = Atom.make((get) => {
  const route = get(voiceRouteAtom);
  if (route) return route.transcriber !== null;
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const permission = createVoiceRecordingPermission(() => {
    // Android keeps recording behind a notification, so the background only cancels preparation.
    if (Platform.OS === "android" && session.controller.currentState.phase === "recording") return;
    void session.controller.appMovedToBackground();
  });
  const recorder = createLazyVoiceRecorder({
    getDestination: () => (registry.get(voiceRouteAtom) === null ? "local" : "environment"),
    // Fork (F8): Android's local transcriber uploads the AAC file, so it never uses upstream's
    // live PCM recorder.
    create: (destination) =>
      destination === "local" && Platform.OS !== "android"
        ? createVoiceRecorder(VOICE_RECORDING_OPTIONS)
        : (createForkAacRecorder() ?? new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS)),
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = deviceMicrophoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    recordingLimitSeconds: RECORDING_LIMIT_SECONDS,
    getTranscriber: () => {
      const route = registry.get(voiceRouteAtom);
      if (route) return route.transcriber;
      const transcriber = registry.get(localVoiceTranscriberAtom);
      return transcriber === "checking" ? null : transcriber;
    },
    requestPermission: permission.requestPermission,
    configureRecording: async () => {
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        // Android keeps recording behind a notification when you switch apps.
        await activateAudioSession(token, false, Platform.OS === "android");
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) =>
      Platform.OS === "android"
        ? void releaseRecording(androidRecordings, uri).catch(() => {})
        : new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      if (status?.isRecording && recorder.uri) streamRecordingAudio(recorder.uri);
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  if (Platform.OS === "android") {
    // Transcribed recordings are cleared from document storage once per launch.
    void pruneSavedTranscripts(androidRecordings).catch(() => {});
  }
  get.subscribe(voiceRouteAtom, () => session.controller.cancel());
  get.addFinalizer(() => {
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isTranscriberAvailable = useAtomValue(voiceInputAvailableAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: isTranscriberAvailable || getNativeShowcaseScene() !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}

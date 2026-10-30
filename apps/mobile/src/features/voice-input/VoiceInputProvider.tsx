import { useAtomValue } from "@effect/atom-react";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  pruneSavedTranscripts,
  releaseRecording,
  voiceInputBlocksSubmission,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { androidRecordings } from "./savedRecordings";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
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
        sampleRate: 44_100,
        numberOfChannels: 1,
        bitRate: 96_000,
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
  // Android's permission dialog pauses the app, which AppState reports as the background.
  let requestingPermission = false;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const recorder = createLazyVoiceRecorder({
    create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
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
      const known = microphoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    recordingLimitSeconds: RECORDING_LIMIT_SECONDS,
    getTranscriber: getLocalVoiceTranscriber,
    requestPermission: async () => {
      requestingPermission = true;
      try {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      } finally {
        requestingPermission = false;
      }
    },
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
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  // iOS reports `inactive` while its permission dialog is open. Only the real
  // background state cancels preparation; recorder status handles calls and
  // route interruptions during capture.
  const appStateSubscription = AppState.addEventListener("change", (nextState) => {
    if (nextState !== "background") return;
    // Android records in the background, so only preparation is cancelled, and not while the
    // permission dialog is what paused the app.
    if (
      Platform.OS === "android" &&
      (session.controller.currentState.phase === "recording" || requestingPermission)
    ) {
      return;
    }
    void session.controller.appMovedToBackground();
  });
  if (Platform.OS === "android") {
    // Transcribed recordings are cleared from document storage once per launch.
    void pruneSavedTranscripts(androidRecordings).catch(() => {});
  }
  get.addFinalizer(() => {
    appStateSubscription.remove();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}

import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { TextInput, View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import {
  clearElevenLabsApiKey,
  readElevenLabsApiKey,
  saveElevenLabsApiKey,
  transcribeRecording,
} from "../voice-input/elevenLabsTranscription";
import {
  deleteSavedRecording,
  listSavedRecordings,
  releaseRecording,
  type SavedRecording,
} from "../voice-input/savedRecordings";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "./components/SettingsSection";

const SAVED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Android-only: the ElevenLabs key and the recordings that are kept until transcribed. */
export function VoiceTranscriptionSettings() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [recordings, setRecordings] = useState<ReadonlyArray<SavedRecording>>([]);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads whether a key is saved in secure storage
  useEffect(() => {
    void readElevenLabsApiKey().then(
      (key) => setHasKey(key !== null),
      () => setHasKey(false),
    );
  }, []);
  const refresh = useCallback(() => {
    void listSavedRecordings().then(setRecordings, () => setRecordings([]));
  }, []);
  useFocusEffect(refresh);

  const saveKey = () => {
    const key = keyDraft.trim();
    if (key.length === 0) return;
    void saveElevenLabsApiKey(key).then(() => {
      setKeyDraft("");
      setHasKey(true);
    });
  };
  const removeKey = () =>
    Dialog.confirm({
      title: "Remove ElevenLabs key?",
      message: "Voice input stops working until you add a key again.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void clearElevenLabsApiKey().then(() => setHasKey(false)),
    });

  const transcribe = async (recording: SavedRecording) => {
    const apiKey = await readElevenLabsApiKey();
    if (!recording.audioUri || !apiKey) {
      Dialog.alert("Add an ElevenLabs API key first.");
      return;
    }
    setTranscribingId(recording.id);
    try {
      const transcript = await transcribeRecording(recording.audioUri, {
        apiKey,
        signal: new AbortController().signal,
        retryDelaysMs: [],
      });
      if (transcript.length === 0) {
        Dialog.alert("No speech was detected.", "The recording is still saved.");
      } else {
        releaseRecording(recording.audioUri);
        Dialog.alert("Transcribed", transcript, [
          { text: "Done", style: "cancel" },
          { text: "Copy", onPress: () => void Clipboard.setStringAsync(transcript) },
        ]);
      }
    } catch (error) {
      Dialog.alert(
        "Could not transcribe",
        error instanceof Error ? error.message : "Try again later.",
      );
    }
    // React Compiler skips components that use `finally`.
    setTranscribingId(null);
    refresh();
  };
  const remove = (recording: SavedRecording) =>
    Dialog.confirm({
      title: "Delete this recording?",
      message: recording.transcript ? undefined : "It has not been transcribed.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        deleteSavedRecording(recording);
        refresh();
      },
    });
  const openRecording = (recording: SavedRecording) => {
    const title = SAVED_AT_FORMAT.format(recording.savedAt);
    if (recording.transcript !== null) {
      Dialog.alert(title, recording.transcript, [
        { text: "Delete", style: "destructive", onPress: () => remove(recording) },
        { text: "Done", style: "cancel" },
        { text: "Copy", onPress: () => void Clipboard.setStringAsync(recording.transcript ?? "") },
      ]);
      return;
    }
    Dialog.alert(title, "This recording has not been transcribed.", [
      { text: "Delete", style: "destructive", onPress: () => remove(recording) },
      { text: "Cancel", style: "cancel" },
      { text: "Transcribe", onPress: () => void transcribe(recording) },
    ]);
  };

  return (
    <>
      <SettingsSection
        title="Transcription"
        footer="Voice input is transcribed by ElevenLabs Scribe. The key stays on this phone."
      >
        <View className="gap-3 bg-grouped-card p-4">
          <Text className="text-sm text-foreground-muted">
            {hasKey === null
              ? "Checking for a key…"
              : hasKey
                ? "An ElevenLabs API key is saved."
                : "Add an ElevenLabs API key to use voice input."}
          </Text>
          <TextInput
            accessibilityLabel="ElevenLabs API key"
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={hasKey ? "Replace the key" : "ElevenLabs API key"}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={keyDraft}
            onChangeText={setKeyDraft}
            onSubmitEditing={saveKey}
          />
          <View className="flex-row gap-2">
            <Button label="Save key" disabled={keyDraft.trim().length === 0} onPress={saveKey} />
            {hasKey ? <Button label="Remove" tone="danger" onPress={removeKey} /> : null}
          </View>
        </View>
      </SettingsSection>
      <SettingsSection
        title="Saved recordings"
        footer="Recordings are kept until they are transcribed. Transcripts are kept for a week."
      >
        {recordings.length === 0 ? (
          <View className="bg-grouped-card p-4">
            <Text className="text-sm text-foreground-muted">No saved recordings.</Text>
          </View>
        ) : (
          recordings.map((recording) => (
            <SettingsActionRow
              key={recording.id}
              icon={recording.transcript === null ? "mic" : "doc.on.doc"}
              label={SAVED_AT_FORMAT.format(recording.savedAt)}
              description={recording.transcript ?? "Not transcribed yet"}
              loading={transcribingId === recording.id}
              onPress={() => openRecording(recording)}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

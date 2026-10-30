import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  deleteSavedRecording,
  listSavedRecordings,
  retrySavedRecording,
  type SavedRecording,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { requestConfirmDialog } from "../../confirmDialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { webElevenLabsRecordings } from "../../voiceInput/elevenLabsVoiceInput";
import { webRecordings } from "../../voiceInput/savedRecordings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SAVED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function loadRecordings(set: (recordings: ReadonlyArray<SavedRecording>) => void): void {
  void listSavedRecordings(webRecordings).then(set, () => set([]));
}

/** The composer mic's kept recordings, like Android's Settings > Microphone. They belong to this browser. */
export function VoiceRecordingsSettingsSection() {
  const scopeKind = useOptionalSettingsScope()?.scope.kind;
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [recordings, setRecordings] = useState<ReadonlyArray<SavedRecording>>([]);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "Transcript copied" }),
  });
  const refresh = () => loadRecordings(setRecordings);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the recordings kept in IndexedDB
  useEffect(() => loadRecordings(setRecordings), []);
  if (scopeKind === "project" || scopeKind === "checkout") return null;

  const transcribe = async (recording: SavedRecording) => {
    if (!recording.audioUri) return;
    setTranscribingId(recording.id);
    try {
      const transcript = await retrySavedRecording(
        webElevenLabsRecordings([...enabledEnvironmentIds(catalog)]),
        recording.audioUri,
      );
      toastManager.add(
        transcript.length === 0
          ? {
              type: "warning",
              title: "No speech was detected.",
              description: "The recording is still saved.",
            }
          : { type: "success", title: "Transcribed", description: transcript },
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not transcribe",
        description: error instanceof Error ? error.message : "Try again later.",
      });
    }
    // React Compiler skips components that use `finally`.
    setTranscribingId(null);
    refresh();
  };
  const remove = async (recording: SavedRecording) => {
    const confirmed =
      (await requestConfirmDialog(
        recording.transcript === null
          ? "Delete this recording? It has not been transcribed."
          : "Delete this recording?",
        { variant: "destructive" },
      )) ?? true;
    if (!confirmed) return;
    await deleteSavedRecording(webRecordings, recording).catch(() => {});
    refresh();
  };

  return (
    <SettingsSection id="voice-input" title="Voice input">
      <SettingsRow
        {...searchableSetting("voice-recordings")}
        description="The mic keeps each recording until it is transcribed, as the Android app does. Transcripts are kept for a week."
        status={recordings.length === 0 ? "No saved recordings." : undefined}
      />
      {recordings.map((recording) => (
        <SettingsRow
          key={recording.id}
          title={SAVED_AT_FORMAT.format(recording.savedAt)}
          description={
            <span className="line-clamp-3">{recording.transcript ?? "Not transcribed yet"}</span>
          }
          control={
            <div className="flex shrink-0 gap-2">
              {recording.transcript === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={transcribingId !== null}
                  onClick={() => void transcribe(recording)}
                >
                  {transcribingId === recording.id ? "Transcribing…" : "Transcribe"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(recording.transcript ?? "", undefined)}
                >
                  Copy
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={transcribingId === recording.id}
                onClick={() => void remove(recording)}
              >
                Delete
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}

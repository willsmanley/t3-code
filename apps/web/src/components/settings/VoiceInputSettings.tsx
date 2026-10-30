import { useElevenLabsApiKey } from "../../voiceInput/elevenLabsVoiceInput";
import { DraftInput } from "../ui/draft-input";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The composer mic's ElevenLabs key. It belongs to this browser, not to a project. */
export function VoiceInputSettingsSection() {
  const scopeKind = useOptionalSettingsScope()?.scope.kind;
  const [apiKey, setApiKey] = useElevenLabsApiKey();
  if (scopeKind === "project" || scopeKind === "checkout") return null;
  return (
    <SettingsSection id="voice-input" title="Voice input">
      <SettingsRow
        {...searchableSetting("elevenlabs-api-key")}
        description="The composer's mic transcribes with ElevenLabs, the same as the Android app. The key is kept in this browser only."
        control={
          <DraftInput
            size="sm"
            type="password"
            className="w-full sm:w-72"
            value={apiKey ?? ""}
            onCommit={(next) => setApiKey(next.trim() || null)}
            placeholder="Not set"
            autoComplete="off"
            spellCheck={false}
            aria-label="ElevenLabs API key"
          />
        }
      />
    </SettingsSection>
  );
}

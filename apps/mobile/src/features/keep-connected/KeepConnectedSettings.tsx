// Fork (F21): Settings → Environments, Android only. A device setting, never synced to a server.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  formatReturnSummary,
  KEEP_CONNECTED_MINUTES,
  summarizeReturns,
} from "./keepConnectedLogic";
import {
  keepConnectedAvailable,
  readKeepConnectedMinutes,
  writeKeepConnectedMinutes,
} from "./keepConnectedNative";
import { readReturnLog, subscribeReturnLog } from "./keepConnectedTracking";

const label = (minutes: number) =>
  minutes === 0 ? "Off" : minutes === 1 ? "1 minute" : `${minutes} minutes`;

export function KeepConnectedSettings() {
  if (Platform.OS !== "android" || !keepConnectedAvailable()) return null;
  return <KeepConnectedSettingsSection />;
}

function KeepConnectedSettingsSection() {
  const [minutes, setMinutes] = useState(readKeepConnectedMinutes);
  const [summary, setSummary] = useState<string | null>(null);
  const refreshSummary = useCallback(() => {
    setSummary(formatReturnSummary(summarizeReturns(readReturnLog(), Date.now())));
  }, []);
  useFocusEffect(refreshSummary);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a return logged while this page stays open updates the summary
  useEffect(() => subscribeReturnLog(refreshSummary), [refreshSummary]);

  return (
    <View className="mt-5 gap-2">
      <SettingsSection
        title="Stay connected after leaving"
        footer="After you switch to another app, T3 Code keeps running and connected this long, with a notification, so coming back is instant."
      >
        {KEEP_CONNECTED_MINUTES.map((option, index) => (
          <ListChoiceRow
            key={option}
            label={label(option)}
            selected={minutes === option}
            separated={index > 0}
            onPress={() => setMinutes(writeKeepConnectedMinutes(option))}
          />
        ))}
      </SettingsSection>
      {summary ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {summary}
        </Text>
      ) : null}
    </View>
  );
}

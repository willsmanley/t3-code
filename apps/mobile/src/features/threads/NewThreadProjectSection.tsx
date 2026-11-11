// Fork (F20): "New threads start here" on a project's settings page. The choice lives on the
// project's server, beside its folder list, so every client starts new threads there.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { setNewThreadProject, threadFolderSettings } from "./threadFolderActions";

export function NewThreadProjectSection(props: {
  readonly members: ReadonlyArray<EnvironmentProject>;
}) {
  const current = useAtomValue(threadFolderSettings.newThreadProjectAtom);
  const supported = useAtomValue(threadFolderSettings.supportedEnvironmentIdsAtom);
  const target = props.members.find((member) => supported.includes(member.environmentId));
  if (target === undefined) return null;
  const checked = props.members.some(
    (member) => member.environmentId === current?.environmentId && member.id === current.projectId,
  );
  return (
    <SettingsSection title="New threads">
      <SettingsSwitchRow
        icon="square.and.pencil"
        label="New threads start here"
        subtitle="The new-thread button, folder buttons, the assistant and the desktop start new threads in this project. Folders still sort them."
        value={checked}
        onValueChange={(on) =>
          void setNewThreadProject(
            on ? { environmentId: target.environmentId, projectId: target.id } : null,
          )
        }
      />
    </SettingsSection>
  );
}

// Fork (F20): "New threads start here" on a project's settings page. The choice lives on the
// project's server, beside its folder list, so every client starts new threads there.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  setNewThreadProject,
  threadFolderSettings,
  useNewThreadProjectRef,
} from "../legacySidebarFolders.store";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

interface ProjectMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

export function NewThreadProjectSettingsRow({
  members,
  preferred,
  disabled,
}: {
  readonly members: ReadonlyArray<ProjectMember>;
  /** The checkout to use when the project lives on several machines. */
  readonly preferred: ProjectMember;
  readonly disabled: boolean;
}) {
  const current = useNewThreadProjectRef();
  const supported = useAtomValue(threadFolderSettings.supportedEnvironmentIdsAtom);
  const candidates = members.filter((member) => supported.includes(member.environmentId));
  if (candidates.length === 0) return null;
  const target = candidates.includes(preferred) ? preferred : candidates[0]!;
  const checked = members.some(
    (member) => member.environmentId === current?.environmentId && member.id === current.projectId,
  );
  return (
    <SettingsRow
      title="New threads start here"
      description="New threads from the new-thread shortcut, folder buttons, the phone and the Android assistant start in this project. Folders still sort them."
      control={
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(on) =>
            void setNewThreadProject(
              on ? { environmentId: target.environmentId, projectId: target.id } : null,
            )
          }
          aria-label="Start new threads in this project"
        />
      }
    />
  );
}

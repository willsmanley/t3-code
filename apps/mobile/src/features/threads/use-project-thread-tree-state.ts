import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_PROJECTS: ReadonlySet<string> = new Set();

/**
 * Collapsed projects persist like the desktop tree. "Show more" is per visit,
 * so a long project returns to its preview the next time the list mounts.
 */
export function useProjectThreadTreeState() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const collapsedProjectGroups = loaded
    ? preferencesResult.value.collapsedProjectGroups
    : undefined;
  const collapsedProjectKeys = useMemo(
    () => (collapsedProjectGroups ? new Set(collapsedProjectGroups) : NO_PROJECTS),
    [collapsedProjectGroups],
  );
  const [expandedProjectKeys, setExpandedProjectKeys] = useState(NO_PROJECTS);

  // A transform reads the optimistic value, so quick repeated taps each toggle.
  const toggleProjectCollapsed = (projectKey: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const keys = new Set(current.collapsedProjectGroups ?? []);
        if (keys.has(projectKey)) keys.delete(projectKey);
        else keys.add(projectKey);
        return { collapsedProjectGroups: [...keys] };
      },
    });
  };
  const toggleProjectExpanded = (projectKey: string) =>
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });

  return {
    loaded,
    collapsedProjectKeys,
    expandedProjectKeys,
    toggleProjectCollapsed,
    toggleProjectExpanded,
  } as const;
}

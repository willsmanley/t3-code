import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { applyProjectMove, mergeProjectOrder, type ProjectMove } from "./projectThreadTree";

const NO_PROJECTS: ReadonlySet<string> = new Set();
const NO_ORDER: ReadonlyArray<string> = [];

/**
 * Collapsed projects and the arranged project order persist like the desktop
 * tree. "Show more" is per visit, so a long project returns to its preview the
 * next time the list mounts.
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
  const projectOrder = (loaded ? preferencesResult.value.projectOrder : undefined) ?? NO_ORDER;
  const [expandedProjectKeys, setExpandedProjectKeys] = useState(NO_PROJECTS);
  const [arrangingProjects, setArrangingProjects] = useState(false);

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
  const moveProject = (projectKey: string, move: ProjectMove) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        projectOrder: applyProjectMove(current.projectOrder ?? [], projectKey, move),
      }),
    });
  };

  return {
    loaded,
    collapsedProjectKeys,
    expandedProjectKeys,
    projectOrder,
    arrangingProjects,
    toggleProjectCollapsed,
    toggleProjectExpanded,
    moveProject,
    openProjectArrangement: () => setArrangingProjects(true),
    closeProjectArrangement: () => setArrangingProjects(false),
  } as const;
}

/**
 * Saves projects the arranged order has not listed yet, so a project stops
 * moving once it has been shown instead of following recent activity.
 */
export function useRememberProjectOrder(
  projectTree: Pick<ReturnType<typeof useProjectThreadTreeState>, "loaded" | "projectOrder">,
  visibleProjectKeys: ReadonlyArray<string>,
) {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const known = new Set(projectTree.projectOrder);
  const unseen = projectTree.loaded ? visibleProjectKeys.filter((key) => !known.has(key)) : [];
  // A string key, so a rebuilt list with the same projects does not save again.
  const unseenJson = unseen.length === 0 ? null : JSON.stringify(unseen);
  useEffect(() => {
    if (unseenJson === null) return;
    const keys: string[] = JSON.parse(unseenJson);
    savePreferences({
      transform: (current) => ({
        projectOrder: mergeProjectOrder(current.projectOrder ?? [], keys),
      }),
    });
  }, [savePreferences, unseenJson]);
}

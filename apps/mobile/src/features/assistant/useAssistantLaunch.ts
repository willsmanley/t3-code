import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";
import { useLinkTo, useNavigation } from "@react-navigation/native";

import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";
import { requestAssistantDictation } from "./assistantDictation";
import { assistantDraftParams, isAssistantLaunchUrl } from "./assistantLaunch";

const configuredProjectRoot = Constants.expoConfig?.extra?.assistantProjectRoot;
const ASSISTANT_PROJECT_ROOT =
  typeof configuredProjectRoot === "string" && configuredProjectRoot.trim().length > 0
    ? configuredProjectRoot.trim()
    : null;

/**
 * Each time Android opens the app as its digital assistant, start a new thread in the build's
 * assistant project, already listening. Without one, or when no connected environment has it,
 * open Choose project.
 */
export function useAssistantLaunch(): void {
  const navigation = useNavigation();
  const linkTo = useLinkTo();
  const projects = useProjects();
  const { state: catalogState } = useWorkspaceState();
  // Each launch gets its own id, which also becomes its draft's request id.
  const [launchId, setLaunchId] = useState<string | null>(null);
  const handledLaunchIdRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the launch link; the router ignores it
  useEffect(() => {
    let cancelled = false;
    void Linking.getInitialURL().then((url) => {
      if (!cancelled && url !== null && isAssistantLaunchUrl(url)) setLaunchId(uuidv4());
    });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (isAssistantLaunchUrl(url)) setLaunchId(uuidv4());
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const loadingProjects =
    catalogState.isLoadingConnections ||
    (!catalogState.hasLoadedShellSnapshot &&
      catalogState.hasConnectingEnvironment &&
      catalogState.connectionError === null);

  // oxlint-disable-next-line t3code/react-effect-budget -- navigates once the launch's project has loaded
  useEffect(() => {
    if (launchId === null || handledLaunchIdRef.current === launchId) return;
    const draft = assistantDraftParams(projects, ASSISTANT_PROJECT_ROOT, launchId);
    if (draft === null && loadingProjects) return;
    handledLaunchIdRef.current = launchId;
    if (draft === null) {
      linkTo("/new");
      return;
    }
    requestAssistantDictation();
    navigation.dispatch(selectWorkspaceDetail({ name: "Thread", params: { draft } }));
  }, [launchId, linkTo, loadingProjects, navigation, projects]);
}

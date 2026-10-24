import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useRef } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "../threads/threadForkNavigation";
import { FORK_CONVERSATION_FAILURE_TITLE, forkThreadFromLatestStable } from "./thread-fork";
import { checkThreadOperationPermission } from "./useThreadListActions";

// Matches web: a fork over a relay can take a few seconds to stream back.
const FORKED_THREAD_SHELL_WAIT_MS = 5_000;

async function waitForForkedThreadShell(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  const arrived = await waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
    timeoutMs: FORKED_THREAD_SHELL_WAIT_MS,
  });
  return arrived ? appAtomRegistry.get(atom) : null;
}

export function useThreadForkAction(openThread: (thread: EnvironmentThreadShell) => void) {
  const forkMutation = useAtomCommand(threadEnvironment.forkFromLatestStable, {
    reportFailure: false,
  });
  const inFlightThreadKeys = useRef(new Set<string>());

  return async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, FORK_CONVERSATION_FAILURE_TITLE)) return false;
    return forkThreadFromLatestStable(thread, {
      inFlight: inFlightThreadKeys.current,
      newThreadId: () => ThreadId.make(uuidv4()),
      fork: forkMutation,
      waitForThread: waitForForkedThreadShell,
      openThread,
      alert: Dialog.alert,
      onStarted: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    });
  };
}

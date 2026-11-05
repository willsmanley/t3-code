import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  isWorkerThread,
  WORKER_THREAD_TAG,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";

/** Fork: "Move to Workers" tags the thread "worker"; "Move to Projects" removes the tag. */
export async function toggleThreadWorkerTag(thread: EnvironmentThreadShell): Promise<void> {
  const tagged = !isWorkerThread(thread.source);
  const title = tagged ? "Could not move thread to Workers" : "Could not move thread to Projects";
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, "This connection cannot change threads.");
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setTag,
    {
      environmentId: thread.environmentId,
      input: { threadId: thread.id, tag: WORKER_THREAD_TAG, tagged },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "Try again.");
  }
}

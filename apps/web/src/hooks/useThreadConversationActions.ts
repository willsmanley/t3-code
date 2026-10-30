import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { selectNativeProviderThreadId } from "../lib/threadProviderIdentity";
import { newThreadId } from "../lib/utils";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useStableCallback } from "./useStableCallback";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useThreadConversationActions() {
  const router = useRouter();
  const pendingForks = useRef(new Set<string>());
  const forkFromLatestStable = useOrchestrationCommand(threadEnvironment.forkFromLatestStable, {
    reportFailure: false,
  });
  const readIdentity = useAtomCommand(orchestrationEnvironment.threadIdentity, {
    reportFailure: false,
  });

  // Catches every failure, so the caller always clears its pending entry.
  const forkAndOpen = async (source: ScopedThreadRef, title: string): Promise<boolean> => {
    let created = false;
    try {
      const target = scopeThreadRef(source.environmentId, newThreadId());
      const result = await forkFromLatestStable({
        environmentId: source.environmentId,
        input: {
          sourceThreadId: source.threadId,
          targetThreadId: target.threadId,
          title: `${title} fork`,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          failureToast("Could not fork conversation", squashAtomCommandFailure(result));
        }
        return false;
      }
      created = true;
      if (!(await waitForThreadShell(target))) {
        failureToast(
          "Conversation forked, but could not open it",
          new Error(
            "The fork was created, but has not reached this client. Open it from the sidebar after reconnecting.",
          ),
        );
        return false;
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target),
      });
      return true;
    } catch (error) {
      failureToast(
        created ? "Conversation forked, but could not open it" : "Could not fork conversation",
        error,
      );
      return false;
    }
  };

  const forkConversation = useStableCallback(async (source: ScopedThreadRef): Promise<boolean> => {
    const key = scopedThreadKey(source);
    if (pendingForks.current.has(key)) return false;
    const thread = readThreadShell(source);
    if (!thread) return false;
    pendingForks.current.add(key);
    // React Compiler skips hooks that use `finally`.
    const forked = await forkAndOpen(source, thread.title);
    pendingForks.current.delete(key);
    return forked;
  });

  const copyProviderSessionId = useStableCallback(
    async (source: ScopedThreadRef): Promise<void> => {
      try {
        const result = await readIdentity({
          environmentId: source.environmentId,
          input: { threadId: source.threadId },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            failureToast("Could not read provider session ID", squashAtomCommandFailure(result));
          }
          return;
        }
        const nativeId = selectNativeProviderThreadId(result.value);
        if (nativeId === null) {
          toastManager.add({
            type: "info",
            title: "Provider session ID unavailable",
            description: "This conversation does not have a native provider session ID yet.",
          });
          return;
        }
        if (await writeTextToClipboard(nativeId, "provider session ID")) {
          toastManager.add({
            type: "success",
            title: "Provider session ID copied",
            description: nativeId,
          });
        }
      } catch (error) {
        failureToast("Failed to copy provider session ID", error);
      }
    },
  );

  return { forkConversation, copyProviderSessionId };
}

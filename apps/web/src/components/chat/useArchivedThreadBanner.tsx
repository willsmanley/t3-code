import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ArchiveIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { type ComposerBannerStackItem } from "./ComposerBannerStack";

/** An archived thread opened anyway (a worker's): say so, and offer to bring it back. */
export function useArchivedThreadBanner(
  threadRef: ScopedThreadRef | null,
  archived: boolean,
): ComposerBannerStackItem | null {
  const { unarchiveThread } = useThreadActions();
  const [unarchiving, setUnarchiving] = useState(false);
  if (threadRef === null || !archived) return null;
  const unarchive = async () => {
    setUnarchiving(true);
    const result = await unarchiveThread(threadRef);
    setUnarchiving(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not unarchive thread",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return {
    id: `thread-archived:${threadRef.environmentId}:${threadRef.threadId}`,
    variant: "default",
    icon: <ArchiveIcon />,
    title: "This thread is archived",
    description: "Scheduled runs can't post here until it's unarchived.",
    actions: (
      <Button size="xs" variant="ghost" disabled={unarchiving} onClick={() => void unarchive()}>
        Unarchive
      </Button>
    ),
  };
}

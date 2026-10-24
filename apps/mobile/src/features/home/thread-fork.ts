import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";

export const FORK_CONVERSATION_FAILURE_TITLE = "Could not fork conversation";
const FORK_OPEN_FAILURE_TITLE = "Conversation forked, but could not open it";

export interface ThreadForkRequest {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly title: string;
    readonly creationSource: "mobile";
  };
}

export interface ThreadForkDependencies<Target> {
  /** Source thread keys with a fork in flight, so a repeated tap cannot fork twice. */
  readonly inFlight: Set<string>;
  readonly newThreadId: () => ThreadId;
  readonly fork: (request: ThreadForkRequest) => Promise<AtomCommandResult<unknown, unknown>>;
  /** Resolves with the new thread once its shell reaches this device, or null on timeout. */
  readonly waitForThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<Target | null>;
  readonly openThread: (thread: Target) => void;
  readonly alert: (title: string, message: string) => void;
  readonly onStarted?: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function forkThreadFromLatestStable<Target>(
  source: Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">,
  deps: ThreadForkDependencies<Target>,
): Promise<boolean> {
  const key = scopedThreadKey(source.environmentId, source.id);
  if (deps.inFlight.has(key)) return false;
  deps.inFlight.add(key);
  let created = false;
  try {
    deps.onStarted?.();
    const targetThreadId = deps.newThreadId();
    const result = await deps.fork({
      environmentId: source.environmentId,
      input: {
        sourceThreadId: source.id,
        targetThreadId,
        title: `${source.title} fork`,
        creationSource: "mobile",
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        deps.alert(
          FORK_CONVERSATION_FAILURE_TITLE,
          errorMessage(squashAtomCommandFailure(result), "The conversation could not be forked."),
        );
      }
      return false;
    }
    created = true;
    const target = await deps.waitForThread(source.environmentId, targetThreadId);
    if (target === null) {
      deps.alert(
        FORK_OPEN_FAILURE_TITLE,
        "The fork has not reached this device yet. Open it from the thread list after reconnecting.",
      );
      return false;
    }
    deps.openThread(target);
    return true;
  } catch (error) {
    deps.alert(
      created ? FORK_OPEN_FAILURE_TITLE : FORK_CONVERSATION_FAILURE_TITLE,
      errorMessage(error, "An error occurred."),
    );
    return false;
  } finally {
    deps.inFlight.delete(key);
  }
}

import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

type ProviderThread = OrchestrationV2ThreadProjection["providerThreads"][number];

export function selectNativeProviderThreadId(projection: {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "activeProviderThreadId">;
  readonly providerThreads: ReadonlyArray<Pick<ProviderThread, "id" | "nativeThreadRef">>;
}): string | null {
  const active = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  // A replacement session may not have a native ID yet. Never copy the old session's ID.
  return active?.nativeThreadRef?.nativeId || null;
}

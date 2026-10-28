import { useEffect } from "react";

// An assistant launch that never reaches a draft composer (a failed load, a dismissed screen)
// shouldn't start the microphone in some later draft.
const PENDING_DICTATION_MS = 15_000;

let pendingSince: number | null = null;

/** Called by the assistant launch just before it opens its new draft. */
export function requestAssistantDictation(now = Date.now()): void {
  pendingSince = now;
}

/** True once for the launch that asked, and only while the request is fresh. */
export function takeAssistantDictation(now = Date.now()): boolean {
  const pending = pendingSince !== null && now - pendingSince < PENDING_DICTATION_MS;
  pendingSince = null;
  return pending;
}

/**
 * Starts dictation in the first draft composer that opens after an assistant launch, so holding
 * power goes straight to listening. `ownerKey` is null for composers that aren't new drafts.
 */
export function useAssistantDictation(
  ownerKey: string | null,
  available: boolean,
  start: () => void,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the microphone once the assistant's draft composer is ready
  useEffect(() => {
    if (ownerKey !== null && available && takeAssistantDictation()) start();
  }, [ownerKey, available, start]);
}

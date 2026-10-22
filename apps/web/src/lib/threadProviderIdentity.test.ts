import { ProviderDriverKind, ProviderThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectNativeProviderThreadId } from "./threadProviderIdentity";

const activeId = ProviderThreadId.make("t3-internal-provider-thread");
const nativeRef = (driver: string, nativeId: string | null) => ({
  driver: ProviderDriverKind.make(driver),
  nativeId,
  strength: "strong" as const,
});

describe("selectNativeProviderThreadId", () => {
  it.each(["codex", "claudeAgent"])("copies the native %s ID, not the T3 ID", (driver) => {
    expect(
      selectNativeProviderThreadId({
        thread: { activeProviderThreadId: activeId },
        providerThreads: [
          { id: activeId, nativeThreadRef: nativeRef(driver, "native-session-uuid") },
          { id: ProviderThreadId.make("another"), nativeThreadRef: nativeRef(driver, "wrong-id") },
        ],
      }),
    ).toBe("native-session-uuid");
  });

  it("does not fall back to a previous session while a replacement is starting", () => {
    expect(
      selectNativeProviderThreadId({
        thread: { activeProviderThreadId: activeId },
        providerThreads: [
          { id: ProviderThreadId.make("old"), nativeThreadRef: nativeRef("codex", "old-session") },
          { id: activeId, nativeThreadRef: null },
        ],
      }),
    ).toBeNull();
  });

  it.each([null, activeId])("returns null without a matching native identity (%s)", (id) => {
    expect(
      selectNativeProviderThreadId({
        thread: { activeProviderThreadId: id },
        providerThreads: [{ id: activeId, nativeThreadRef: nativeRef("codex", null) }],
      }),
    ).toBeNull();
  });
});

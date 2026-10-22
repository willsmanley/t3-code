import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  fork: vi.fn(),
  identity: vi.fn(),
  waitForShell: vi.fn(),
  navigate: vi.fn(),
  clipboard: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }) }));
vi.mock("./useStableCallback", () => ({ useStableCallback: (callback: unknown) => callback }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: state.navigate }) }));
vi.mock("../state/entities", () => ({
  readThreadShell: () => ({ title: "Source conversation" }),
  waitForThreadShell: state.waitForShell,
}));
vi.mock("../lib/utils", () => ({ newThreadId: () => "fork" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { forkFromLatestStable: "fork" } }));
vi.mock("../state/orchestration", () => ({
  orchestrationEnvironment: { threadIdentity: "identity" },
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "fork" ? state.fork : state.identity),
}));
vi.mock("./useCopyToClipboard", () => ({ writeTextToClipboard: state.clipboard }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: state.toast },
}));

import { useThreadConversationActions } from "./useThreadConversationActions";

const source = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("source") };
const providerThreadId = ProviderThreadId.make("internal-provider-id");
function setup() {
  state.granted = new Set(["remote"]);
  state.fork.mockReset().mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  state.identity.mockReset().mockResolvedValue(
    AsyncResult.success({
      thread: { activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "native-uuid",
            strength: "strong",
          },
        },
      ],
    }),
  );
  state.waitForShell.mockReset().mockResolvedValue(true);
  state.navigate.mockReset().mockResolvedValue(undefined);
  state.clipboard.mockReset().mockResolvedValue(true);
  state.toast.mockReset();
  return useThreadConversationActions();
}

describe("sidebar conversation actions", () => {
  it("waits for the fork before opening it in the source environment and suppresses duplicate clicks", async () => {
    const actions = setup();
    let complete!: (ready: boolean) => void;
    state.waitForShell.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
    );
    const first = actions.forkConversation(source);
    expect(await actions.forkConversation(source)).toBe(false);
    expect(state.fork).toHaveBeenCalledTimes(1);
    expect(state.fork).toHaveBeenCalledWith({
      environmentId: "remote",
      input: {
        sourceThreadId: "source",
        targetThreadId: "fork",
        title: "Source conversation fork",
      },
    });
    expect(state.navigate).not.toHaveBeenCalled();
    complete(true);
    expect(await first).toBe(true);
    expect(state.waitForShell).toHaveBeenCalledWith({ environmentId: "remote", threadId: "fork" });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "remote", threadId: "fork" },
    });
  });

  it("checks the source environment's permission at execution", async () => {
    const actions = setup();
    state.granted = new Set(["primary"]);
    expect(await actions.forkConversation(source)).toBe(false);
    expect(state.fork).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("reports a rejected fork without navigating and allows retry", async () => {
    const actions = setup();
    state.fork.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("No stable response"))),
    );
    expect(await actions.forkConversation(source)).toBe(false);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "No stable response" }),
    );
    expect(await actions.forkConversation(source)).toBe(true);
  });

  it("does not claim the fork failed when only synchronization failed", async () => {
    const actions = setup();
    state.waitForShell.mockResolvedValue(false);
    expect(await actions.forkConversation(source)).toBe(false);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Conversation forked, but could not open it",
      }),
    );
  });

  it("fetches identity on demand from the selected environment and copies only its native ID", async () => {
    const actions = setup();
    state.granted.clear();
    expect(state.identity).not.toHaveBeenCalled();
    await actions.copyProviderSessionId(source);
    expect(state.identity).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { threadId: "source" },
    });
    expect(state.clipboard).toHaveBeenCalledWith("native-uuid", "provider session ID");
  });

  it("leaves the clipboard alone when no native session exists", async () => {
    const actions = setup();
    state.identity.mockResolvedValue(
      AsyncResult.success({
        thread: { activeProviderThreadId: null },
        providerThreads: [],
      }),
    );
    await actions.copyProviderSessionId(source);
    expect(state.clipboard).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Provider session ID unavailable",
      }),
    );
  });

  it("reports clipboard failures without a success toast", async () => {
    const actions = setup();
    state.clipboard.mockRejectedValue(new Error("Clipboard denied"));
    await actions.copyProviderSessionId(source);
    expect(state.toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to copy provider session ID",
        description: "Clipboard denied",
      }),
    );
  });
});

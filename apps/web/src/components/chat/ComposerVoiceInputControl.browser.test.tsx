import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

// The shipped defaults, so this also checks that Mod+Shift+Space reaches the mic.
vi.mock(import("@effect/atom-react"), async (original) => {
  const { DEFAULT_KEYBINDINGS, compileResolvedKeybindingsConfig } =
    await import("@t3tools/shared/keybindings");
  const compiled = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);
  return { ...(await original()), useAtomValue: (() => compiled) as never };
});
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_KEYBINDINGS, compileResolvedKeybindingsConfig } =
    await import("@t3tools/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS)),
  };
});

import { BackgroundThreadContext } from "./backgroundThread";
import { ComposerVoiceInputControl } from "./ComposerVoiceInputControl";

function control(phase: VoiceInputPhase, options: { disabled?: boolean } = {}) {
  const handlers = {
    onStart: vi.fn(),
    onConfirm: vi.fn(),
    onConfirmWithoutSending: vi.fn(),
    onCancel: vi.fn(),
  };
  const element = (
    <>
      <form>
        <ComposerVoiceInputControl
          phase={phase}
          recordingStartedAt={phase === "recording" ? 0 : null}
          disabled={options.disabled ?? false}
          {...handlers}
        />
      </form>
      <input aria-label="Search threads" />
    </>
  );
  return { element, ...handlers };
}

const shortcut = () => userEvent.keyboard("{Control>}[Space]{/Control}");
const linux = () => vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");

describe("voice input shortcut", () => {
  it("starts a dictation", async () => {
    using _platform = linux();
    const idle = control("idle");
    await using _screen = await render(idle.element);
    await shortcut();
    expect(idle.onStart).toHaveBeenCalledOnce();
  });

  it("sends a recording, and Escape cancels one", async () => {
    using _platform = linux();
    const recording = control("recording");
    await using _screen = await render(recording.element);
    await shortcut();
    expect(recording.onConfirm).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(recording.onCancel).toHaveBeenCalledOnce();
  });

  it("sends a recording on Enter, and Shift+Enter only fills the draft", async () => {
    using _platform = linux();
    const recording = control("recording");
    await using _screen = await render(recording.element);
    await userEvent.keyboard("{Enter}");
    expect(recording.onConfirm).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(recording.onConfirmWithoutSending).toHaveBeenCalledOnce();
  });

  it("leaves Enter alone in a field outside the composer", async () => {
    using _platform = linux();
    const recording = control("recording");
    await using screen = await render(recording.element);
    await userEvent.click(screen.getByRole("textbox", { name: "Search threads" }));
    await userEvent.keyboard("{Enter}");
    expect(recording.onConfirm).not.toHaveBeenCalled();
  });

  it("does nothing while the mic is unavailable", async () => {
    using _platform = linux();
    const disabled = control("idle", { disabled: true });
    await using _screen = await render(disabled.element);
    await shortcut();
    expect(disabled.onStart).not.toHaveBeenCalled();
  });

  it("leaves a background thread's mic alone", async () => {
    using _platform = linux();
    const background = control("recording");
    await using _screen = await render(
      <BackgroundThreadContext value={true}>{background.element}</BackgroundThreadContext>,
    );
    await shortcut();
    await userEvent.keyboard("{Escape}");
    expect(background.onConfirm).not.toHaveBeenCalled();
    expect(background.onCancel).not.toHaveBeenCalled();
  });
});

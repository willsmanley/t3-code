import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PrimeSettings } from "../settings.ts";
import { checkPrimeProviderStatus } from "./status.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(PrimeSettings)({ enabled: true });

/** `prime-agent model list` from 0.10.2, rows trimmed. */
const MODEL_TABLE = [
  "provider    model                       context  max-out  thinking  images",
  "cpa-claude  claude-opus-5-5             200K     64K      yes       yes   ",
  "cpa-codex   gpt-6-luna                  200K     64K      yes       yes   ",
  "openrouter  meta-llama/llama-5-scout    128K     16K      no        no    ",
  "",
].join("\n");
const NO_MODELS =
  "No models available. Use /login to log into a provider via OAuth or API key. See:\n" +
  "  /home/user/.local/share/prime-agent/docs/providers.md\n" +
  "  /home/user/.local/share/prime-agent/docs/models.md\n";

function processHandle(stdout: string, code: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_201),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Answers `prime-agent` invocations by their arguments and records which ran. */
const check = (modelList: string) =>
  Effect.gen(function* () {
    const outputs: Record<string, string> = {
      "--version": "0.10.2\n",
      "model list": modelList,
    };
    const invoked: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
      invoked.push(args);
      const stdout = outputs[args];
      return Effect.succeed(processHandle(stdout ?? "", stdout === undefined ? 2 : 0));
    });
    const draft = yield* checkPrimeProviderStatus(settings, {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { draft, invoked };
  }).pipe(Effect.provide(NodeServices.layer));

describe("checkPrimeProviderStatus", () => {
  it.effect("lists Prime's models as provider/model without opening a session", () =>
    Effect.gen(function* () {
      const { draft, invoked } = yield* check(MODEL_TABLE);
      assert.deepEqual(invoked, ["--version", "model list"]);
      assert.equal(draft.status, "ready");
      assert.equal(draft.version, "0.10.2");
      assert.equal(draft.auth.status, "authenticated");
      assert.deepEqual(
        draft.models.map((model) => [model.slug, model.name, model.subProvider]),
        [
          ["default", "Prime default", undefined],
          ["cpa-claude/claude-opus-5-5", "claude-opus-5-5", "cpa-claude"],
          ["cpa-codex/gpt-6-luna", "gpt-6-luna", "cpa-codex"],
          // A model id with its own slash keeps it after the provider.
          ["openrouter/meta-llama/llama-5-scout", "meta-llama/llama-5-scout", "openrouter"],
        ],
      );
      // Only models Prime marks as thinking offer a reasoning level.
      assert.deepEqual(
        draft.models.map((model) => model.capabilities?.optionDescriptors?.length ?? 0),
        [1, 1, 1, 0],
      );
    }),
  );

  it.effect("reports Prime without models as signed out, and unreadable output as unknown", () =>
    Effect.gen(function* () {
      const signedOut = yield* check(NO_MODELS);
      assert.equal(signedOut.draft.status, "error");
      assert.equal(signedOut.draft.auth.status, "unauthenticated");
      assert.deepEqual(
        signedOut.draft.models.map((model) => model.slug),
        ["default"],
      );

      // A future table T3 cannot read is not reported as signed out.
      const unreadable = yield* check("Provider | Model\nprime | x\n");
      assert.equal(unreadable.draft.status, "warning");
      assert.equal(unreadable.draft.auth.status, "unknown");
    }),
  );
});

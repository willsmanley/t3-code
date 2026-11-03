import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makePrimeAcpRuntime } from "./acpSupport.ts";

const idleProcess = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(900_000_301),
  exitCode: Effect.never,
  isRunning: Effect.succeed(true),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.never,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

/** Builds Prime's runtime against a spawner that records the launch and never answers. */
const launch = (resumeSessionId?: string) =>
  Effect.gen(function* () {
    const launches: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command))
        launches.push([command.command, ...command.args.map(String)]);
      return Effect.succeed(idleProcess);
    });
    const exit = yield* makePrimeAcpRuntime({
      cwd: "/work",
      clientInfo: { name: "t3-test", version: "0" },
      primeSettings: { binaryPath: "/opt/prime-agent" },
      sessionDirectory: (sessionId) => `/state/prime-agent/prime/${sessionId}`,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.scoped,
      Effect.exit,
    );
    return { exit, launches };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("makePrimeAcpRuntime", () => {
  it.effect("gives a new session its own directory and continues it there when reopened", () =>
    Effect.gen(function* () {
      const created = yield* launch();
      assert.isTrue(Exit.isSuccess(created.exit));
      const [command, ...args] = created.launches[0] ?? [];
      assert.equal(command, "/opt/prime-agent");
      assert.deepEqual(args.slice(0, 3), ["--mode", "acp", "--session-dir"]);
      assert.match(args[3] ?? "", /^\/state\/prime-agent\/prime\/[0-9a-f-]{36}$/);
      assert.lengthOf(args, 4);

      const reopened = yield* launch("0b4c1d2e-5f60-4718-9a2b-3c4d5e6f7081");
      assert.isTrue(Exit.isSuccess(reopened.exit));
      assert.deepEqual(reopened.launches, [
        [
          "/opt/prime-agent",
          "--mode",
          "acp",
          "--session-dir",
          "/state/prime-agent/prime/0b4c1d2e-5f60-4718-9a2b-3c4d5e6f7081",
          "--continue",
        ],
      ]);
    }),
  );

  // The id names a directory, so one from elsewhere must not reach the path.
  it.effect("refuses to continue a session id that is not T3's", () =>
    Effect.gen(function* () {
      const { exit, launches } = yield* launch("../../.ssh");
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(launches, []);
    }),
  );
});

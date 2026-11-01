import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "../state/runtime.ts";
import {
  ServerDictationRejected,
  ServerDictationUnsupported,
  type ServerDictationTransport,
} from "./serverDictation.ts";

export function createServerDictationCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    append: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:append-audio",
      tag: WS_METHODS.voiceDictationAppend,
    }),
    transcribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:transcribe",
      tag: WS_METHODS.voiceDictationTranscribe,
    }),
  };
}

function tagOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : null;
}

/**
 * A lost or missing connection is retried. The server's own errors are passed on, and anything
 * else (an older server without these RPCs, a protocol defect) means it can't transcribe.
 */
function classifyFailure(error: unknown): Error {
  const tag = tagOf(error);
  if (tag === "VoiceDictationError") {
    const reason =
      typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "";
    const message = error instanceof Error ? error.message : "The server could not transcribe.";
    return new ServerDictationRejected(reason, message);
  }
  if (tag === "EnvironmentRpcUnavailableError") return new Error("The server is not connected.");
  if (
    tag === "RpcClientError" &&
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    tagOf(error.reason) !== "RpcClientDefect"
  ) {
    return new Error("The connection to the server was lost.");
  }
  return new ServerDictationUnsupported();
}

export function serverDictationTransport(
  registry: AtomRegistry.AtomRegistry,
  commands: ReturnType<typeof createServerDictationCommands>,
  environmentId: EnvironmentId,
): ServerDictationTransport {
  return {
    append: async (input) => {
      const result = await runAtomCommand(
        registry,
        commands.append,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw classifyFailure(squashAtomCommandFailure(result));
      return result.value;
    },
    transcribe: async (input) => {
      const result = await runAtomCommand(
        registry,
        commands.transcribe,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw classifyFailure(squashAtomCommandFailure(result));
      return result.value;
    },
  };
}

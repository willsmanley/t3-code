import { type ServerProviderModel } from "@t3tools/contracts";
import type { PrimeSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  PRIME_DRIVER_KIND,
  PRIME_SUPPORTED_RUNTIME_MODES,
  PRIME_THOUGHT_LEVEL_OPTION_DESCRIPTOR,
} from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const PRIME_PRESENTATION = {
  displayName: "Prime Agent",
  showInteractionModeToggle: false,
  supportedRuntimeModes: PRIME_SUPPORTED_RUNTIME_MODES,
} as const;
const PRIME_THINKING_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [PRIME_THOUGHT_LEVEL_OPTION_DESCRIPTOR],
});
const PRIME_PLAIN_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

interface PrimeListedModel {
  readonly provider: string;
  readonly model: string;
  readonly thinking: boolean;
}

/**
 * Reads the table `prime-agent model list` prints: a header row, then one
 * whitespace-separated row per model starting with provider and model id.
 * Prime has no JSON form of this list. Without models it prints "No models
 * available…" instead. `undefined` means output in neither form.
 */
function parsePrimeModelList(stdout: string): ReadonlyArray<PrimeListedModel> | undefined {
  const [header, ...rows] = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (header?.startsWith("No models available")) return [];
  const columns = header?.split(/\s+/) ?? [];
  if (columns[0] !== "provider" || columns[1] !== "model") return undefined;
  const thinkingColumn = columns.indexOf("thinking");
  return rows.flatMap((row) => {
    const cells = row.split(/\s+/);
    const [provider, model] = cells;
    if (provider === undefined || model === undefined) return [];
    return [
      {
        provider,
        model,
        thinking: thinkingColumn === -1 || cells[thinkingColumn] !== "no",
      },
    ];
  });
}

/**
 * Models as `provider/model`. There is no "Prime default" entry: Prime saves
 * every model switch as its default, so that entry meant whichever model any
 * session used last.
 */
const primeModels = (
  settings: PrimeSettings,
  listed: ReadonlyArray<PrimeListedModel> = [],
): ReadonlyArray<ServerProviderModel> => {
  const seen = new Set<string>();
  return providerModelsFromSettings(
    listed.flatMap(({ provider, model, thinking }) => {
      const slug = `${provider}/${model}`;
      if (seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: model,
          subProvider: provider,
          isCustom: false,
          capabilities: thinking ? PRIME_THINKING_CAPABILITIES : PRIME_PLAIN_CAPABILITIES,
        },
      ];
    }),
    settings.customModels,
    PRIME_THINKING_CAPABILITIES,
  );
};

const snapshot = (
  settings: PrimeSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed?: ReadonlyArray<PrimeListedModel>,
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: PRIME_DRIVER_KIND,
    presentation: PRIME_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: primeModels(settings, listed),
    probe,
  }),
  // Prime only answers through a full agent session, which it saves; titles
  // and commit messages come from another provider.
  supportsTextGeneration: false,
});

export const buildInitialPrimeProviderSnapshot = (
  settings: PrimeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Prime Agent availability..."
        : "Prime Agent is disabled in T3 Code settings.",
    }),
  );

const runPrimeCli = Effect.fn("runPrimeCli")(function* (
  settings: PrimeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "prime-agent";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * Reads `prime-agent --version` and `prime-agent model list`. Neither opens a
 * session. Prime lists only models it has credentials for, so an empty list
 * means nothing is signed in.
 */
export const checkPrimeProviderStatus = Effect.fn("checkPrimeProviderStatus")(function* (
  settings: PrimeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Prime Agent is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runPrimeCli(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Prime Agent is not installed or not on PATH."
        : "Failed to run `prime-agent --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Prime Agent is installed but failed to run.",
    });
  }

  const listed = yield* runPrimeCli(settings, ["model", "list"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.map(Option.filter((output) => output.code === 0)),
    Effect.map(
      Option.flatMap((output) => Option.fromUndefinedOr(parsePrimeModelList(output.stdout))),
    ),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<PrimeListedModel>>()),
  );
  if (Option.isNone(listed)) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Prime Agent is installed but `prime-agent model list` could not be read.",
    });
  }
  if (listed.value.length === 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Prime Agent has no models. Run `prime-agent` and use /login, or add models.json.",
    });
  }
  return snapshot(
    settings,
    checkedAt,
    { installed: true, version, status: "ready", auth: { status: "authenticated" } },
    listed.value,
  );
});

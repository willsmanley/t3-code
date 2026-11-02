import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { PrimeSettings } from "../settings.ts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  applyPrimeModelSelection,
  applyPrimeThoughtLevelDefault,
  makePrimeAcpRuntime,
  normalizePrimeToolCall,
  PRIME_DRIVER_KIND,
  primeLostBackgroundService,
  primePromptFailure,
} from "./acpSupport.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

export { PRIME_DRIVER_KIND } from "./acpSupport.ts";

const DEFAULT_PRIME_SETTINGS = Schema.decodeSync(PrimeSettings)({});

const PrimeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface PrimeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: PrimeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Prime's session directory for one T3 session id. */
  readonly sessionDirectory: (sessionId: string) => string;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Replaces the `prime-agent --mode acp` launch (adapter tests). */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

function makePrimeAcpAdapterFlavor(options: PrimeAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    (({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }: AcpAdapterV2RuntimeInput) =>
      makePrimeAcpRuntime({
        ...input,
        primeSettings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
        sessionDirectory: options.sessionDirectory,
      }));
  return {
    driver: PRIME_DRIVER_KIND,
    runtimeHarness: "prime-agent",
    capabilities: PrimeProviderCapabilitiesV2,
    // Prime takes HTTP MCP servers directly, so T3's tools need no stdio bridge.
    mcpOverHttp: true,
    makeRuntime,
    normalizeToolCall: normalizePrimeToolCall,
    promptFailure: primePromptFailure,
    // A replacement process continues the thread's session (`--continue`).
    restartRuntimeAfterPromptError: primeLostBackgroundService,
    relaunchOnActiveSession: true,
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyPrimeModelSelection(runtime, modelSelection).pipe(
        Effect.tap(() => applyPrimeThoughtLevelDefault(runtime, modelSelection)),
      ),
  };
}

export const makePrimeAdapterV2 = Effect.fn("makePrimeAdapterV2")(function* (
  options: PrimeAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makePrimeAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type PrimeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const PrimeAdapterV2Driver: ProviderAdapterDriver<PrimeSettings, PrimeAdapterV2DriverEnv> = {
  driverKind: PRIME_DRIVER_KIND,
  configSchema: PrimeSettings,
  defaultConfig: (): PrimeSettings => DEFAULT_PRIME_SETTINGS,
  create: Effect.fn("PrimeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PrimeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const host = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      const sessionsRoot = path.join(host.paths.stateDir, "prime-agent", input.instanceId);
      return yield* makePrimeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        sessionDirectory: (sessionId) => path.join(sessionsRoot, sessionId),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: PRIME_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PRIME_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Prime Agent ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { PrimeSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  type AcpToolCallState,
  collectSessionConfigOptionValues,
} from "@t3tools/provider-acp/server/runtimeModel";

export const PRIME_DRIVER_KIND = ProviderDriverKind.make("prime");
/** T3's slug for "Default": the model Prime's own settings pick, never a Prime model id. */
export const PRIME_DEFAULT_MODEL_SLUG = "default";
const PRIME_MODEL_CONFIG_ID = "model";
const PRIME_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const PRIME_DEFAULT_THOUGHT_LEVEL = "high";

const PRIME_THOUGHT_LEVEL_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const;

export const PRIME_THOUGHT_LEVEL_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: PRIME_THOUGHT_LEVEL_CONFIG_ID,
  label: "Reasoning",
  type: "select",
  options: Object.entries(PRIME_THOUGHT_LEVEL_LABELS).map(([id, label]) => ({
    id,
    label,
    ...(id === PRIME_DEFAULT_THOUGHT_LEVEL ? { isDefault: true } : {}),
  })),
};

/** Prime runs model-written Python with the user's permissions and never asks first. */
export const PRIME_SUPPORTED_RUNTIME_MODES = [
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/**
 * Prime's ACP model values are JSON `[provider, model]` pairs; T3 shows them
 * as `provider/model`, the form `prime-agent --model` and `rlm.spawn` take.
 */
const PrimeModelValue = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const decodePrimeModelValue = Schema.decodeUnknownOption(PrimeModelValue);

function primeModelSlug(value: string): string | undefined {
  return Option.getOrUndefined(
    Option.map(decodePrimeModelValue(value), ([provider, model]) => `${provider}/${model}`),
  );
}

function primeModelValue(slug: string): string | undefined {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return undefined;
  return JSON.stringify([slug.slice(0, slash), slug.slice(slash + 1)]);
}

/**
 * Writes config id `model`. "Default" keeps the model Prime's settings gave
 * the session. A `provider/model` pair the session does not list is still
 * sent: Prime resolves it against its own models.json and refuses unknown
 * ones, so a thread never runs on a model it did not pick.
 */
export const applyPrimeModelSelection = Effect.fn("applyPrimeModelSelection")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
): Effect.fn.Return<string | undefined, EffectAcpErrors.AcpError> {
  const option = (yield* runtime.getConfigOptions).find(
    (entry) => entry.id === PRIME_MODEL_CONFIG_ID && entry.type === "select",
  );
  const current = option?.type === "select" ? option.currentValue : undefined;
  const requested = modelSelection.model.trim();
  if (requested.length === 0 || requested === PRIME_DEFAULT_MODEL_SLUG) {
    return current === undefined ? undefined : primeModelSlug(current);
  }
  const target = primeModelValue(requested);
  if (target === undefined) {
    return yield* new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: `Prime Agent models are written provider/model; "${requested}" has no provider.`,
      data: { configId: PRIME_MODEL_CONFIG_ID, receivedValue: requested },
    });
  }
  if (target !== current) {
    yield* runtime.setConfigOption(PRIME_MODEL_CONFIG_ID, target, { allowUnlistedValue: true });
  }
  return requested;
});

/** The shared option loop writes a stored reasoning level; a thread without one starts at high. */
export const applyPrimeThoughtLevelDefault = Effect.fn("applyPrimeThoughtLevelDefault")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
  if (getModelSelectionStringOptionValue(modelSelection, PRIME_THOUGHT_LEVEL_CONFIG_ID)) return;
  const option = (yield* runtime.getConfigOptions).find(
    (entry) => entry.id === PRIME_THOUGHT_LEVEL_CONFIG_ID && entry.type === "select",
  );
  if (
    option?.type === "select" &&
    option.currentValue !== PRIME_DEFAULT_THOUGHT_LEVEL &&
    collectSessionConfigOptionValues(option).includes(PRIME_DEFAULT_THOUGHT_LEVEL)
  ) {
    yield* runtime.setConfigOption(PRIME_THOUGHT_LEVEL_CONFIG_ID, PRIME_DEFAULT_THOUGHT_LEVEL);
  }
});

/** Prime does all its work in Python cells; show a cell's code as its command. */
export function normalizePrimeToolCall(tool: AcpToolCallState): AcpToolCallState {
  const rawInput = tool.data.rawInput;
  const code =
    typeof rawInput === "object" && rawInput !== null && "code" in rawInput
      ? rawInput.code
      : undefined;
  return tool.command === undefined && typeof code === "string" && code.trim().length > 0
    ? { ...tool, command: code.trim() }
    : tool;
}

/** The `data` of Prime's failed-prompt reply: its message and classification. */
const decodePrimeTurnFailure = Schema.decodeUnknownOption(
  Schema.Struct({
    details: Schema.String,
    kind: Schema.optional(Schema.String),
    retryable: Schema.optional(Schema.Boolean),
  }),
);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

function primeTurnFailure(error: unknown) {
  return isAcpRequestError(error)
    ? Option.getOrUndefined(decodePrimeTurnFailure(error.data))
    : undefined;
}

/**
 * Prime's ACP process outlives its background service (`prime-agent update`,
 * `shutdown`, a crash) but then fails every prompt, so T3 replaces it.
 */
export function primeLostBackgroundService(error: unknown): boolean {
  return /daemon connection (is )?closed/.test(primeTurnFailure(error)?.details ?? "");
}

/** Shows Prime's own reason for a failed turn instead of a bare "Internal error". */
export function primePromptFailure(error: unknown) {
  const failure = primeTurnFailure(error);
  if (failure === undefined) return makeProviderFailure({ cause: error, class: "provider_error" });
  if (primeLostBackgroundService(error)) {
    return makeProviderFailure({
      cause: error,
      class: "transport_error",
      message:
        "Prime Agent's background service stopped during this turn. Send it again to continue.",
      retryable: true,
    });
  }
  return makeProviderFailure({
    cause: error,
    message: failure.details,
    class:
      failure.kind === "rate_limit"
        ? "usage_limit"
        : failure.kind === "model_transport"
          ? "transport_error"
          : "provider_error",
    retryable: failure.retryable ?? null,
  });
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Prime cannot load a session and gives each connection a fresh session id, so
 * a T3 session keeps its own id and Prime directory (reopened with `--continue`).
 * T3 sees only that id: resume answers for it and forwarded updates carry it.
 */
export function withPrimeStableSession(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  stableSessionId: string,
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  let primeSessionId: string | undefined;
  let presented: AcpSessionRuntime.AcpSessionRuntimeStartResult | undefined;
  const present = (
    result: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ): AcpSessionRuntime.AcpSessionRuntimeStartResult => {
    primeSessionId = result.sessionId;
    const agentCapabilities = result.initializeResult.agentCapabilities ?? {};
    presented = {
      ...result,
      sessionId: stableSessionId,
      initializeResult: {
        ...result.initializeResult,
        agentCapabilities: {
          ...agentCapabilities,
          sessionCapabilities: { ...agentCapabilities.sessionCapabilities, resume: {} },
        },
      },
    };
    return presented;
  };
  const start = () => runtime.start().pipe(Effect.map(present));
  const rename = <T extends { readonly sessionId: string }>(message: T): T =>
    message.sessionId === primeSessionId ? { ...message, sessionId: stableSessionId } : message;
  const unknownSession = (sessionId: string) =>
    new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: `Prime Agent session ${sessionId} is not open in this process.`,
    });
  return {
    ...runtime,
    start,
    resumeSession: (sessionId) =>
      sessionId === stableSessionId
        ? presented === undefined
          ? start()
          : Effect.succeed(presented)
        : Effect.fail(unknownSession(sessionId)),
    loadSession: (sessionId) => Effect.fail(unknownSession(sessionId)),
    closeSession: () => runtime.closeSession(),
    handleSessionUpdate: (handler) =>
      runtime.handleSessionUpdate((notification) => handler(rename(notification))),
    handleRequestPermission: (handler) =>
      runtime.handleRequestPermission((request, context) => handler(rename(request), context)),
  };
}

interface PrimeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn" | "cancelBehavior" | "resumeSessionId" | "resumeMethod"
> {
  readonly primeSettings: Pick<PrimeSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
  /** The T3 session id to continue; absent for a new session. */
  readonly resumeSessionId?: string;
  /** Prime's session directory for one T3 session id. */
  readonly sessionDirectory: (sessionId: string) => string;
}

export const makePrimeAcpRuntime = Effect.fn("makePrimeAcpRuntime")(function* (
  input: PrimeAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const { primeSettings, environment, resumeSessionId, sessionDirectory, ...runtimeOptions } =
    input;
  if (resumeSessionId !== undefined && !SESSION_ID_PATTERN.test(resumeSessionId)) {
    return yield* new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: `"${resumeSessionId}" is not a Prime Agent session id from T3 Code.`,
    });
  }
  const sessionId =
    resumeSessionId ??
    (yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to generate a Prime Agent session id.",
            cause,
          }),
      ),
    ));
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: primeSettings.binaryPath || "prime-agent",
        args: [
          "--mode",
          "acp",
          "--session-dir",
          sessionDirectory(sessionId),
          ...(resumeSessionId === undefined ? [] : ["--continue"]),
        ],
        cwd: input.cwd,
        env: { ...environment },
      },
      // Prime answers a cancelled prompt with `stopReason: cancelled`.
      cancelBehavior: "wait-for-prompt",
    }),
  );
  const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(context),
  );
  return withPrimeStableSession(runtime, sessionId);
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import { PrimeSettings } from "@t3tools/provider-prime/settings";
import {
  makePrimeAdapterV2,
  PRIME_DRIVER_KIND,
  withPrimeStableSession,
} from "@t3tools/provider-prime/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const ENABLED_PRIME_SETTINGS = Schema.decodeSync(PrimeSettings)({ enabled: true });
/** The id T3 keeps for a thread whose Prime session it created. */
const NEW_SESSION_ID = "t3-prime-new";
const OPUS = '["cpa-claude","claude-opus-5-5"]';
const LUNA = '["cpa-codex","gpt-6-luna"]';

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>"): Frame => ({
  type: "expect_outbound",
  label: method,
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown): Frame => ({
  type: "emit_inbound",
  label: `${method}.result`,
  frame: { kind: "response", method, result },
});
const update = (sessionId: string, sessionUpdate: Record<string, unknown>): Frame => ({
  type: "emit_inbound",
  label: `session/update:${String(sessionUpdate.sessionUpdate)}`,
  frame: {
    kind: "notification",
    method: "session/update",
    params: { sessionId, update: sessionUpdate },
  },
});

/** Prime 0.10.2's session config, models trimmed. */
const primeConfig = (input: { readonly model: string; readonly thoughtLevel: string }) => [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: input.model,
    options: [
      { value: OPUS, name: "claude-opus-5-5 (cpa-claude)" },
      { value: LUNA, name: "gpt-6-luna (cpa-codex)" },
    ],
  },
  {
    id: "thought_level",
    name: "Reasoning effort",
    type: "select",
    category: "thought_level",
    currentValue: input.thoughtLevel,
    options: ["off", "minimal", "low", "medium", "high"].map((value) => ({ value, name: value })),
  },
];

/** Prime 0.10.2's `initialize` reply: no session/load and no session/resume. */
const initialize: ReadonlyArray<Frame> = [
  outbound("initialize"),
  answer("initialize", {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true },
      sessionCapabilities: { close: {} },
    },
    agentInfo: { name: "prime-agent", title: "Prime Agent", version: "0.10.2" },
  }),
];

const setConfig = (
  primeSessionId: string,
  configId: string,
  value: string,
  configAfter: ReadonlyArray<unknown>,
): ReadonlyArray<Frame> => [
  outbound("session/set_config_option", { sessionId: primeSessionId, configId, value }),
  answer("session/set_config_option", { configOptions: configAfter }),
];

/** One turn under Prime's id, answered with `reply`, then the session closes. */
const turn = (primeSessionId: string, reply: string): ReadonlyArray<Frame> => [
  outbound("session/prompt", { sessionId: primeSessionId, prompt: "<any>" }),
  // Prime 0.10.2 reports every action as a Python cell.
  update(primeSessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "toolu_cell_1",
    title: "Python cell",
    kind: "execute",
    status: "in_progress",
    rawInput: { code: "\nprint(17 * 23)\n" },
  }),
  update(primeSessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_cell_1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "391" } }],
  }),
  update(primeSessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "prime-agent-assistant-1",
    content: { type: "text", text: reply },
  }),
  answer("session/prompt", { stopReason: "end_turn" }),
  // Closing the T3 session closes Prime's own session id.
  outbound("session/close", { sessionId: primeSessionId }),
  answer("session/close", {}),
];

/**
 * Opens a Prime session against a scripted ACP agent and runs one turn. The
 * runtime is the replay agent behind Prime's stable-session wrapper, which
 * is what `makePrimeAcpRuntime` returns around `prime-agent --mode acp`.
 */
const runPrimeTurn = Effect.fn("runPrimeTurn")(function* (input: {
  readonly scenario: string;
  readonly frames: ReadonlyArray<Frame>;
  readonly model: string;
  /** Reopens this T3 session id instead of starting one. */
  readonly resumeSessionId?: string;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-prime-${input.scenario}-`,
  });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: PRIME_DRIVER_KIND,
      protocol: ACP_PROTOCOL,
      version: "1",
      scenario: input.scenario,
      entries: input.frames as never,
    },
    PRIME_DRIVER_KIND,
  );
  const replayRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath,
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    cancelBehavior: "wait-for-prompt",
  });
  const resumedIds: Array<string | undefined> = [];
  const instanceId = ProviderInstanceId.make(`prime-${input.scenario}`);
  const adapter = yield* makePrimeAdapterV2({
    instanceId,
    settings: ENABLED_PRIME_SETTINGS,
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    sessionDirectory: (sessionId) => path.join(replayDir, sessionId),
    makeRuntime: ({ resumeSessionId, ...runtimeInput }) => {
      resumedIds.push(resumeSessionId);
      return replayRuntime(runtimeInput).pipe(
        Effect.map((runtime) => withPrimeStableSession(runtime, resumeSessionId ?? NEW_SESSION_ID)),
      );
    },
  });
  const threadId = ThreadId.make(`thread-prime-${input.scenario}`);
  const modelSelection = { instanceId, model: input.model };
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: replayDir,
  });
  const result = yield* Effect.gen(function* () {
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-prime-${input.scenario}`),
      modelSelection,
      runtimePolicy,
      ...(input.resumeSessionId === undefined
        ? {}
        : { initialNativeThreadId: input.resumeSessionId }),
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${threadId}`),
        title: "Prime adapter test",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run:${threadId}:1`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt:${threadId}:1`),
      rootNodeId: NodeId.make(`node:${threadId}:1`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message:${threadId}:1`),
        text: "ping",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const events = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const replies = events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? [event.turnItem.text]
        : [],
    );
    const commands = events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
        ? [event.turnItem.input]
        : [],
    );
    const terminal = events.find((event) => event.type === "turn.terminal");
    return {
      nativeThreadId: providerThread.nativeThreadRef?.nativeId,
      reply: replies.at(-1),
      command: commands.at(-1),
      terminalStatus: terminal?.type === "turn.terminal" ? terminal.status : undefined,
    };
  }).pipe(Effect.scoped);
  yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
  return { ...result, resumedIds };
});

describe("PrimeAdapterV2", () => {
  // Prime names each connection's session itself, so T3 must keep its own id
  // for the thread and still see the turn Prime streams under Prime's id.
  it.effect("keeps T3's session id for a new thread and streams Prime's replies into it", () =>
    Effect.gen(function* () {
      const result = yield* runPrimeTurn({
        scenario: "new-session",
        model: "cpa-codex/gpt-6-luna",
        frames: [
          ...initialize,
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", {
            sessionId: "prime-acp-1",
            configOptions: primeConfig({ model: OPUS, thoughtLevel: "medium" }),
          }),
          // `provider/model` goes out as Prime's JSON pair.
          ...setConfig(
            "prime-acp-1",
            "model",
            LUNA,
            primeConfig({ model: LUNA, thoughtLevel: "medium" }),
          ),
          // A thread without a stored reasoning level runs at high.
          ...setConfig(
            "prime-acp-1",
            "thought_level",
            "high",
            primeConfig({ model: LUNA, thoughtLevel: "high" }),
          ),
          ...turn("prime-acp-1", "pong"),
        ],
      });
      assert.deepEqual(result.resumedIds, [undefined]);
      assert.equal(result.nativeThreadId, NEW_SESSION_ID);
      assert.equal(result.reply, "pong");
      // A Python cell shows its code, not Prime's generic "Python cell" title.
      assert.equal(result.command, "print(17 * 23)");
      assert.equal(result.terminalStatus, "completed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  // Reopening relaunches Prime on the thread's session directory, where
  // `--continue` restores the conversation under a fresh Prime id.
  it.effect("reopens a thread by its T3 id while Prime answers under a new id", () =>
    Effect.gen(function* () {
      const result = yield* runPrimeTurn({
        scenario: "reopened-session",
        model: "default",
        resumeSessionId: "t3-prime-1",
        frames: [
          ...initialize,
          // Never session/load or session/resume, which Prime lacks.
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", {
            sessionId: "prime-acp-2",
            configOptions: primeConfig({ model: OPUS, thoughtLevel: "high" }),
          }),
          ...turn("prime-acp-2", "still here"),
        ],
      });
      assert.deepEqual(result.resumedIds, ["t3-prime-1"]);
      assert.equal(result.nativeThreadId, "t3-prime-1");
      assert.equal(result.reply, "still here");
      assert.equal(result.terminalStatus, "completed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

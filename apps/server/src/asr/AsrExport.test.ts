// @effect-diagnostics nodeBuiltinImport:off -- Synthetic SQLite and filesystem fixtures exercise the real offline export boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import * as AsrExport from "./AsrExport.ts";
import { nativeSession, sessionRef } from "./AsrMapping.ts";

const now = "2026-01-02T03:04:05.123Z";
const namespace = "synthetic-env";
const childId = "thread:delegated-task:command%3Amcp%3Afixture";
const modelSelection = {
  instanceId: "codex",
  model: "synthetic-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

type Row = Record<string, unknown>;
function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-asr-test-"));
  temporary.push(directory);
  const userdata = NodePath.join(directory, "userdata");
  NodeFS.mkdirSync(userdata);
  NodeFS.writeFileSync(NodePath.join(userdata, "environment-id"), `${namespace}\n`);
  const database = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  for (const name of [
    "threads",
    "turn_items",
    "messages",
    "runs",
    "run_attempts",
    "nodes",
    "subagents",
    "provider_threads",
    "provider_turns",
    "runtime_requests",
    "checkpoints",
    "checkpoint_scopes",
    "context_handoffs",
  ]) {
    database.exec(
      `CREATE TABLE orchestration_v2_projection_${name} (thread_id TEXT, payload_json TEXT)`,
    );
  }
  database.exec(
    "CREATE TABLE orchestration_v2_projection_context_transfers (source_thread_id TEXT, target_thread_id TEXT, payload_json TEXT)",
  );
  database.exec(
    "CREATE TABLE orchestration_v2_projection_metadata (projection_name TEXT, schema_version INTEGER, last_sequence INTEGER)",
  );
  database.exec(
    "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT, event_type TEXT, occurred_at TEXT, command_id TEXT, metadata_json TEXT, payload_json TEXT, aggregate_kind TEXT, stream_id TEXT, application_event_version INTEGER)",
  );
  database.exec(
    "CREATE TABLE scheduled_tasks (task_id TEXT, schedule_json TEXT, webhook_secret TEXT)",
  );
  database
    .prepare("INSERT INTO scheduled_tasks VALUES (?, ?, ?)")
    .run(
      "schedule-1",
      JSON.stringify({ type: "webhook", signature: { secretRef: "SYNTHETIC_SECRET_EXCLUDED" } }),
      "SYNTHETIC_SECRET_EXCLUDED",
    );
  let sequence = 0;
  const put = (table: string, value: Row, threadId = "parent") =>
    database
      .prepare(`INSERT INTO orchestration_v2_projection_${table} VALUES (?, ?)`)
      .run(threadId, JSON.stringify(value));
  const event = (
    type: string,
    payload: Row,
    threadId = "parent",
    commandId: string | null = null,
  ) => {
    sequence++;
    database
      .prepare("INSERT INTO orchestration_events VALUES (?, ?, ?, ?, ?, ?, ?, 'thread', ?, 2)")
      .run(
        sequence,
        `event-${sequence}`,
        type,
        now,
        commandId,
        "{}",
        JSON.stringify(payload),
        threadId,
      );
  };
  const thread = (id: string): Row => ({
    id,
    projectId: "project",
    title: "Synthetic export fixture",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: "codex",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/work/synthetic",
    activeProviderThreadId: "provider-parent",
    historyOrigin: "native",
    lineage: {
      parentThreadId: id === "parent" ? null : "parent",
      relationshipToParent: id === "parent" ? null : "subagent",
      rootThreadId: "parent",
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  });
  put("threads", thread("parent"));
  put("threads", thread(childId), childId);
  event("thread.created", thread("parent"));
  const provider: Row = {
    id: "provider-parent",
    driver: "codex",
    providerInstanceId: "codex",
    providerSessionId: null,
    appThreadId: "parent",
    ownerNodeId: null,
    nativeThreadRef: { driver: "codex", nativeId: "native-parent", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  put("provider_threads", provider);
  put(
    "provider_threads",
    {
      ...provider,
      id: "provider-child",
      driver: "claudeAgent",
      appThreadId: childId,
      nativeThreadRef: { driver: "claudeAgent", nativeId: "native-child", strength: "strong" },
    },
    childId,
  );
  const run: Row = {
    id: "run-1",
    threadId: "parent",
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection,
    providerThreadId: "provider-parent",
    userMessageId: "scheduled-task-message:fire-1",
    rootNodeId: "root",
    activeAttemptId: "attempt-1",
    status: "completed",
    queuePosition: 1,
    queueHeld: false,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  put("runs", run);
  event("run.created", { ...run, status: "queued", startedAt: null, completedAt: null });
  event("run.updated", { ...run, status: "running", completedAt: null });
  const attempt: Row = {
    id: "attempt-1",
    nativeThreadId: "native-parent",
    runId: "run-1",
    attemptOrdinal: 1,
    rootNodeId: "root",
    providerInstanceId: "codex",
    providerThreadId: "provider-parent",
    providerTurnId: "native-turn-row",
    reason: "initial",
    status: "completed",
    startedAt: now,
    completedAt: now,
  };
  put("run_attempts", attempt);
  event("run-attempt.created", { ...attempt, status: "running", completedAt: null });
  put("provider_turns", {
    id: "native-turn-row",
    providerThreadId: "provider-parent",
    nodeId: "root",
    runAttemptId: "attempt-1",
    nativeTurnRef: { driver: "codex", nativeId: "native-turn", strength: "strong" },
    ordinal: 1,
    status: "completed",
    startedAt: now,
    completedAt: now,
    turnTokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 0,
      hasSubagents: true,
    },
    tokenUsage: { usedTokens: 12, maxTokens: 100, updatedAt: now },
  });
  let ordinal = 0;
  const item = (type: string, extra: Row, threadId = "parent"): Row => {
    const value = {
      id: `item-${ordinal}`,
      threadId,
      runId: threadId === "parent" ? "run-1" : null,
      nodeId: null,
      providerThreadId: threadId === "parent" ? "provider-parent" : "provider-child",
      providerTurnId: "native-turn-row",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinal++,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type,
      ...extra,
    };
    put("turn_items", value, threadId);
    event("turn-item.updated", value, threadId);
    return value;
  };
  const message = (id: string, extra: Row, threadId = "parent") => {
    const value = {
      id,
      threadId,
      runId: threadId === "parent" ? "run-1" : null,
      nodeId: null,
      role: "user",
      createdBy: "user",
      creationSource: "web",
      text: "  Preserve whitespace.\r\n",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      ...extra,
    };
    put("messages", value, threadId);
    item(
      value.role === "assistant" ? "assistant_message" : "user_message",
      { ...value, id: `message-item-${id}`, messageId: id, inputIntent: "turn_start" },
      threadId,
    );
  };
  message("scheduled-task-message:fire-1", { scheduledTaskId: "schedule-1" });
  message("peer-message", {
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: childId,
    text: "Peer result",
  });
  message("delegated-message", {
    createdBy: "agent",
    creationSource: "server",
    delegatedCompletion: { parentRunId: "run-1", generation: 1, taskIds: ["child-task"] },
  });
  const command = item("command_execution", {
    nodeId: "command-node",
    input: "printf synthetic",
    output: "synthetic\n",
    exitCode: 0,
    nativeItemRef: { driver: "codex", nativeId: "exec-1", strength: "strong" },
  });
  item("dynamic_tool", {
    toolName: "mcp__example__lookup",
    input: { query: "synthetic" },
    output: { count: 0 },
    nativeItemRef: { driver: "codex", nativeId: "lookup-1", strength: "strong" },
  });
  item("command_execution", { input: "sleep 1", status: "running", completedAt: null });
  item("reasoning", {
    text: "Reasoning representation",
    streaming: false,
    nativeItemRef: { driver: "codex", nativeId: "reasoning-1", strength: "strong" },
  });
  const permission: Row = {
    id: "permission-1",
    nodeId: "permission-node",
    providerTurnId: "native-turn-row",
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "not_resumable", reason: "synthetic" },
    createdAt: now,
    resolvedAt: null,
  };
  item("approval_request", {
    requestId: "permission-1",
    requestKind: "command",
    prompt: "Run command?",
    fullAccessOverride: "ask_rule",
    parentItemId: command.id,
    options: [{ decision: "acceptForSession", label: "Allow session" }],
  });
  event("runtime-request.updated", permission);
  const resolvedPermission = {
    ...permission,
    status: "resolved",
    resolvedAt: now,
    decision: "acceptForSession",
  };
  put("runtime_requests", resolvedPermission);
  event("runtime-request.updated", resolvedPermission, "parent", "mcp:opaque-receipt");
  const question: Row = {
    ...permission,
    id: "question-1",
    kind: "user_input",
    status: "resolved",
    resolvedAt: now,
    answers: { q: ["Yes"] },
  };
  put("runtime_requests", question);
  item("user_input_request", {
    requestId: "question-1",
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Continue?",
        options: [{ label: "Yes", description: "Proceed", preview: "Example" }],
        initialAnswer: "Yes",
        required: true,
        multiSelect: false,
        allowCustomAnswer: false,
      },
    ],
  });
  event("runtime-request.updated", question);
  item("secret_request", {
    label: "SYNTHETIC_KEY",
    reason: "Synthetic login",
    secretStatus: "saved",
    delivery: "file",
    answer: "SYNTHETIC_SECRET_EXCLUDED",
  });
  item("compaction", { driver: "codex", beforeTokenCount: 90, afterTokenCount: 12 });
  item("file_change", {
    fileName: "src/example.ts",
    diffStr: "@@ -1 +1 @@\n-a\n+b\n",
    changes: [{ operation: "update", path: "src/example.ts" }],
  });
  item("todo_list", {
    planId: "plan-1",
    steps: [{ id: "step-1", text: "Implement export", status: "completed" }],
  });
  message("assistant-1", {
    role: "assistant",
    createdBy: "agent",
    creationSource: "provider",
    text: "Finished.",
    nativeItemRef: { driver: "codex", nativeId: "native-message", strength: "strong" },
  });
  const child: Row = {
    id: "child-task",
    threadId: "parent",
    runId: "run-1",
    parentNodeId: "root",
    origin: "app_owned",
    createdBy: "agent",
    driver: "claudeAgent",
    providerInstanceId: "claude",
    providerThreadId: "provider-child",
    childThreadId: childId,
    nativeTaskRef: null,
    prompt: "Review the parser",
    title: "Review",
    model: "synthetic-child-model",
    completionWake: "always",
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const promptSequence = sequence + 1;
  event("subagent.updated", child);
  const childDone = { ...child, status: "completed", result: "Reviewed", completedAt: now };
  put("subagents", childDone);
  event("subagent.updated", { ...childDone, prompt: "", promptSequence });
  const checkpoint: Row = {
    id: "checkpoint-1",
    threadId: "parent",
    scopeId: "scope-1",
    runId: "run-1",
    nodeId: "root",
    parentCheckpointId: null,
    ordinalWithinScope: 0,
    appRunOrdinal: 1,
    ref: "refs/t3/orchestration-v2/checkpoints/synthetic",
    status: "missing",
    files: [{ path: "src/example.ts", kind: "modified", additions: 1, deletions: 1 }],
    capturedAt: now,
  };
  put("checkpoints", checkpoint);
  event("checkpoint.captured", checkpoint);
  event("thread.pull-request-link-updated", {
    host: "github.com",
    repository: "example/project",
    number: 42,
    url: "https://github.com/example/project/pull/42",
    source: "agent",
    linkedAt: now,
    snapshot: null,
    stack: null,
  });
  event("run.updated", run);
  event("run-attempt.updated", attempt);
  message(
    "child-message",
    { senderThreadId: "parent", createdBy: "agent", creationSource: "mcp" },
    childId,
  );
  database
    .prepare("INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections', 2, ?)")
    .run(sequence);
  database.close();
  return { directory, userdata, output: NodePath.join(directory, "bundle") };
}

function readBundle(output: string) {
  const manifest: {
    sessions: Array<{
      agent: string;
      sessionId: string;
      status: string;
      path?: string;
      recordCount?: number;
      digest?: { value: string };
    }>;
  } = JSON.parse(NodeFS.readFileSync(NodePath.join(output, "bundle.json"), "utf8"));
  const records = new Map<string, Row[]>();
  for (const entry of manifest.sessions) {
    if (!entry.path) continue;
    const bytes = NodeFS.readFileSync(NodePath.join(output, entry.path));
    expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(entry.digest?.value);
    const stream: Row[] = bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stream.length).toBe(entry.recordCount);
    expect(stream.every((record, index) => record.seq === index)).toBe(true);
    records.set(entry.sessionId, stream);
  }
  const validator = process.env.ASR_VALIDATOR;
  if (validator) {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [validator, output, "--format", "json"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  return { manifest, records };
}

describe("native ASR export", () => {
  it.effect(
    "exports orchestration facts and references backing sessions without reading their transcripts",
    () =>
      Effect.gen(function* () {
        const paths = fixture();
        const before = NodeFS.readFileSync(NodePath.join(paths.userdata, "statev2.sqlite"));
        const exporter = yield* AsrExport.AsrExport;
        const summary = yield* exporter.exportBundle(paths);
        expect(summary.threads).toBe(2);
        const { manifest, records } = readBundle(paths.output);
        const parent = records.get("parent")!;
        const messages = parent.filter((record) => record.type === "message");
        expect(
          messages.find((record) => record.messageId === "scheduled-task-message:fire-1"),
        ).toMatchObject({
          author: "harness",
          origin: "injected",
          content: [],
          displayContent: [{ type: "text", text: "  Preserve whitespace.\r\n" }],
          capture: { content: { state: "absent" } },
        });
        const triggered = parent.filter((record) => record.turnId === "run-1" && record.trigger);
        expect(triggered).toHaveLength(1);
        expect(parent.find((record) => record.turnId === "run-1")).toBe(triggered[0]);
        expect(triggered[0]).toMatchObject({
          trigger: { kind: "webhook", id: "schedule-1", runId: "fire-1" },
        });
        expect(messages.find((record) => record.messageId === "peer-message")).toMatchObject({
          author: "agent",
          origin: "inter_session",
          from: { session: sessionRef({ agent: "t3-code", namespace, sessionId: childId }) },
        });
        expect(messages.find((record) => record.messageId === "delegated-message")).toMatchObject({
          author: "agent",
          origin: "subagent_report",
        });
        expect(parent.some((record) => record.type === "state" && record.state === "queued")).toBe(
          true,
        );
        expect(parent.find((record) => record.attempt)).toMatchObject({
          attempt: { n: 1, reason: "initial" },
          executedBy: { session: "codex:native-parent", turnId: "native-turn" },
        });
        expect(
          parent.find((record) => record.type === "tool_call" && record.callId === "exec-1"),
        ).toMatchObject({ capture: { name: { state: "absent" } }, kind: "execute" });
        const calls = parent.filter((record) => record.type === "tool_call");
        const results = parent.filter((record) => record.type === "tool_result");
        expect(calls.length - results.length).toBe(1);
        expect(results.find((record) => record.callId === "exec-1")).toMatchObject({
          linkage: "exact",
          exec: { exitCode: 0 },
          capture: { content: { state: "absent" } },
        });
        const approvals = parent.filter((record) => record.type === "permission");
        expect(approvals).toHaveLength(2);
        expect(approvals[1]).toMatchObject({
          status: "resolved",
          decision: "allow_session",
          supersedes: approvals[0]!.id,
          subject: { callId: "exec-1" },
        });
        expect(approvals[1]).not.toHaveProperty("decider");
        expect(approvals[1]).not.toHaveProperty("decidedBy");
        expect(
          parent.find(
            (record) => record.type === "input_request" && record.requestId === "question-1",
          ),
        ).toMatchObject({ status: "answered", answers: [{ questionId: "q", selected: ["Yes"] }] });
        expect(
          parent.find((record) => record.type === "input_request" && record.secret),
        ).toMatchObject({ status: "answered", questions: [{ id: "secret", secret: true }] });
        expect(JSON.stringify([...records.values()])).not.toContain("SYNTHETIC_SECRET_EXCLUDED");
        expect(parent.find((record) => record.type === "compaction")).toMatchObject({
          replaces: { state: "unknown" },
          capture: { summary: { state: "absent" } },
        });
        expect(parent.find((record) => record.type === "checkpoint")).toMatchObject({
          kind: "git_ref",
          status: "missing",
        });
        expect(parent.find((record) => record.type === "vcs")).toMatchObject({
          action: "pr_link",
          evidence: "reported",
        });
        const children = parent.filter((record) => record.type === "subagent");
        expect(children).toHaveLength(2);
        expect(children[1]).toMatchObject({
          supersedes: children[0]!.id,
          agent: "claude-code",
          model: { id: "synthetic-child-model" },
          status: "completed",
        });
        expect(
          manifest.sessions
            .filter((entry) => entry.status === "missing")
            .map((entry) => entry.sessionId)
            .sort(),
        ).toEqual(["native-child", "native-parent"]);
        expect(NodeFS.readFileSync(NodePath.join(paths.userdata, "statev2.sqlite"))).toEqual(
          before,
        );
        expect(NodeFS.statSync(paths.output).mode & 0o777).toBe(0o700);
      }).pipe(Effect.provide(AsrExport.layer)),
  );

  it.effect(
    "supports a single thread and refuses existing destinations without changing them",
    () =>
      Effect.gen(function* () {
        const paths = fixture();
        const exporter = yield* AsrExport.AsrExport;
        const summary = yield* exporter.exportBundle({ ...paths, threadId: childId });
        expect(summary.threads).toBe(1);
        const before = NodeFS.readFileSync(NodePath.join(paths.output, "bundle.json"));
        expect(yield* Effect.result(exporter.exportBundle(paths))).toMatchObject({
          _tag: "Failure",
        });
        expect(NodeFS.readFileSync(NodePath.join(paths.output, "bundle.json"))).toEqual(before);
      }).pipe(Effect.provide(AsrExport.layer)),
  );

  it.effect("refuses stale projections and removes partial output when source decoding fails", () =>
    Effect.gen(function* () {
      const paths = fixture();
      const exporter = yield* AsrExport.AsrExport;
      const database = new NodeSqlite.DatabaseSync(NodePath.join(paths.userdata, "statev2.sqlite"));
      database.exec("UPDATE orchestration_v2_projection_metadata SET last_sequence = 0");
      expect(yield* Effect.result(exporter.exportBundle(paths))).toMatchObject({ _tag: "Failure" });
      expect(NodeFS.existsSync(paths.output)).toBe(false);
      database.exec(
        "UPDATE orchestration_v2_projection_metadata SET last_sequence = (SELECT MAX(sequence) FROM orchestration_events)",
      );
      database.exec("UPDATE orchestration_v2_projection_turn_items SET payload_json = '{invalid'");
      database.close();
      expect(yield* Effect.result(exporter.exportBundle(paths))).toMatchObject({ _tag: "Failure" });
      expect(NodeFS.existsSync(paths.output)).toBe(false);
    }).pipe(Effect.provide(AsrExport.layer)),
  );

  it.effect(
    "keeps item order after event compaction and retains request cards without runtime rows",
    () =>
      Effect.gen(function* () {
        const paths = fixture();
        const database = new NodeSqlite.DatabaseSync(
          NodePath.join(paths.userdata, "statev2.sqlite"),
        );
        database.exec(
          "DELETE FROM orchestration_events WHERE event_type IN ('turn-item.updated', 'runtime-request.updated')",
        );
        database.exec("DELETE FROM orchestration_v2_projection_runtime_requests");
        database.exec(
          "UPDATE orchestration_v2_projection_metadata SET last_sequence = (SELECT MAX(sequence) FROM orchestration_events)",
        );
        database.close();
        const exporter = yield* AsrExport.AsrExport;
        yield* exporter.exportBundle(paths);
        const parent = readBundle(paths.output).records.get("parent")!;
        expect(
          parent
            .filter((record) => record.type === "message")
            .slice(0, 3)
            .map((record) => record.messageId),
        ).toEqual(["scheduled-task-message:fire-1", "peer-message", "delegated-message"]);
        expect(parent.find((record) => record.type === "permission")).toMatchObject({
          requestId: "permission-1",
          description: "Run command?",
        });
        expect(parent.find((record) => record.type === "permission")).not.toHaveProperty(
          "decision",
        );
        expect(parent.find((record) => record.requestId === "question-1")).toMatchObject({
          mode: "questions",
          questions: [{ id: "q", text: "Continue?" }],
        });
        const reasoning = parent.find((record) => record.messageId === "reasoning-1");
        expect(reasoning).toMatchObject({
          content: [{ type: "reasoning" }],
          displayContent: [{ type: "text", text: "Reasoning representation" }],
        });
        expect(parent.find((record) => record.type === "config_change")).toMatchObject({
          options: { reasoningEffort: "high" },
        });
      }).pipe(Effect.provide(AsrExport.layer)),
  );

  it.effect(
    "uses historical attempt destinations and aggregates provider turns once per T3 run",
    () =>
      Effect.gen(function* () {
        const paths = fixture();
        const database = new NodeSqlite.DatabaseSync(
          NodePath.join(paths.userdata, "statev2.sqlite"),
        );
        database.exec(
          "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.nativeId', 'recovered-native-session') WHERE thread_id = 'parent'",
        );
        const row = database
          .prepare("SELECT payload_json FROM orchestration_v2_projection_provider_turns")
          .get()!;
        const turn = JSON.parse(String(row.payload_json));
        database
          .prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES ('parent', ?)")
          .run(
            JSON.stringify({
              ...turn,
              id: "second-provider-turn",
              ordinal: 2,
              nativeTurnRef: { driver: "codex", nativeId: "derived-turn", strength: "weak" },
              turnTokenUsage: {
                usageScope: "main_agent",
                usageStatus: "partial",
                inputTokens: 30,
                hasSubagents: false,
              },
            }),
          );
        database.close();
        const exporter = yield* AsrExport.AsrExport;
        yield* exporter.exportBundle(paths);
        const parent = readBundle(paths.output).records.get("parent")!;
        expect(parent[0]).toMatchObject({
          lineage: {
            executedBy: [
              { session: "codex:recovered-native-session" },
              { session: "codex:native-parent" },
            ],
          },
        });
        expect(
          parent.find((record) => record.type === "tool_call" && record.callId === "exec-1"),
        ).toMatchObject({ copiedFrom: { session: "codex:native-parent", proof: "native_field" } });
        expect(parent.filter((record) => record.type === "usage_summary")).toHaveLength(1);
        expect(parent.find((record) => record.type === "usage_summary")).toMatchObject({
          scope: "turn",
          turnId: "run-1",
          coverage: "partial",
          usage: { input: { total: 40, includesCache: true }, output: { total: 2 } },
        });
        expect(
          parent.some(
            (record) => (record.executedBy as Row | undefined)?.turnId === "derived-turn",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(AsrExport.layer)),
  );

  it.effect("preserves duplicate native call IDs without guessing result pairing", () =>
    Effect.gen(function* () {
      const paths = fixture();
      const database = new NodeSqlite.DatabaseSync(NodePath.join(paths.userdata, "statev2.sqlite"));
      const row = database
        .prepare(
          "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE json_extract(payload_json, '$.nativeItemRef.nativeId') = 'exec-1'",
        )
        .get()!;
      const item = JSON.parse(String(row.payload_json));
      database
        .prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES ('parent', ?)")
        .run(JSON.stringify({ ...item, id: "duplicate-call", ordinal: 999 }));
      database.close();
      const exporter = yield* AsrExport.AsrExport;
      yield* exporter.exportBundle(paths);
      const parent = readBundle(paths.output).records.get("parent")!;
      expect(
        parent.filter((record) => record.type === "tool_call" && record.callId === "exec-1"),
      ).toHaveLength(2);
      const results = parent.filter(
        (record) => record.type === "tool_result" && record.callId === "exec-1",
      );
      expect(results).toHaveLength(2);
      expect(results.every((record) => record.linkage === "ambiguous")).toBe(true);
    }).pipe(Effect.provide(AsrExport.layer)),
  );

  it("does not turn weak references or Pi session paths into native session IDs", () => {
    expect(
      nativeSession({ driver: "codex", nativeId: "derived", strength: "weak" }),
    ).toBeUndefined();
    expect(
      nativeSession({
        driver: "pi",
        nativeId: "/work/private/pi-session.jsonl",
        strength: "strong",
      }),
    ).toBeUndefined();
    expect(
      sessionRef({ agent: "t3-code", namespace: "env", sessionId: "thread:delegated%3Atask" }),
    ).toBe("t3-code:env:thread%3Adelegated%253Atask");
  });
});

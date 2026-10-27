// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing assigns deterministic IDs without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type {
  Attempt,
  Checkpoint,
  Handoff,
  Item,
  Message,
  ProviderThread,
  ProviderTurn,
  Request,
  Run,
  StoredEvent,
  Subagent,
  ThreadSource,
} from "./AsrSource.ts";

export type AsrRecord = { type: string; [key: string]: unknown };
type Fields = Record<string, unknown>;
type NativeRef = { driver: string; nativeId: string | null; strength: string };
type RequestDetails = Partial<Request> & Pick<Request, "id">;
export type SessionKey = { agent: string; namespace?: string; sessionId: string };

export function sessionRef(key: SessionKey): string {
  const encode = (value: string) =>
    value.replace(/[%:#\u0000-\u0020\u007f-\u009f]/gu, (char) => encodeURIComponent(char));
  return [
    key.agent,
    ...(key.namespace === undefined ? [] : [encode(key.namespace)]),
    encode(key.sessionId),
  ].join(":");
}

function recordId(kind: string, nativeId: string): string {
  return `r-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify(["1", kind, nativeId]))
    .digest("hex")}`;
}

const text = (value: string) => [{ type: "text", text: value }];
const absent = { state: "absent" };
const snapshot = { mode: "snapshot" };
const present = (value: unknown): boolean => value !== undefined && value !== null;
const fields = (value: Fields): Fields =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => present(entry)));
const meta = (value: Fields): Fields =>
  Object.fromEntries(
    Object.entries(fields(value)).map(([key, entry]) => [`codes.t3/${key}`, entry]),
  );
const vendor = (value: string) => `_codes.t3/${value}`;
function modelOptions(value: unknown): Fields | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value))
    return Object.fromEntries(
      value.map((entry: unknown) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("id" in entry) ||
          typeof entry.id !== "string" ||
          !("value" in entry)
        )
          throw new Error("Invalid model option.");
        return [entry.id, entry.value];
      }),
    );
  if (value !== null && typeof value === "object") return value as Fields;
  throw new Error("Invalid model options.");
}

function agentName(driver: string): string | undefined {
  return (
    {
      claudeAgent: "claude-code",
      codex: "codex",
      pi: "pi",
      cursor: "cursor",
      opencode: "opencode",
      antigravity: "antigravity",
    } as Record<string, string>
  )[driver];
}

export function nativeSession(ref: NativeRef | null | undefined): SessionKey | undefined {
  if (ref?.strength !== "strong" || !ref.nativeId) return undefined;
  const agent = agentName(ref.driver);
  // Only these adapter contracts establish ASR session identity; Pi refs are file locators.
  if (!agent || !["codex", "claudeAgent"].includes(ref.driver)) return undefined;
  if (ref.driver === "claudeAgent" && ref.nativeId.includes(":agent:")) return undefined;
  return { agent, sessionId: ref.nativeId };
}

const callId = (item: Item) =>
  item.nativeItemRef?.strength === "strong" &&
  ["codex", "claudeAgent"].includes(item.nativeItemRef.driver) &&
  item.nativeItemRef.nativeId
    ? item.nativeItemRef.nativeId
    : item.id;
const toolTypes = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
]);
const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);
const decision = (value: string) =>
  ({
    accept: "allow_once",
    acceptForSession: "allow_session",
    acceptAlways: "allow_always",
    decline: "reject_once",
    cancel: "cancelled",
  })[value];
const optionKind = (value: string) =>
  ({
    accept: "allow_once",
    acceptForSession: "allow_session",
    acceptAlways: "allow_always",
    decline: "reject_once",
    cancel: "_codes.t3/cancelled",
  })[value];
function runState(status: string): Fields {
  const state = {
    preparing: { state: "_codes.t3/preparing" },
    starting: { state: "_codes.t3/starting" },
    pending: { state: "_codes.t3/pending" },
    superseded: { state: "_codes.t3/superseded" },
    queued: { state: "queued" },
    running: { state: "running" },
    waiting: { state: "requires_action" },
    completed: { state: "idle", stopReason: "end_turn" },
    interrupted: { state: "idle", stopReason: "cancelled" },
    cancelled: { state: "idle", stopReason: "cancelled" },
    failed: { state: "idle", stopReason: "error" },
  }[status];
  if (!state) throw new Error("Unsupported source execution state.");
  return state;
}

function triggerFor(
  message: Message,
  intent: string | undefined,
  schedules: Map<string, Fields>,
  namespace: string,
): Fields | undefined {
  if (message.scheduledTaskId) {
    const schedule = schedules.get(message.scheduledTaskId);
    return fields({
      kind:
        schedule?.type === "webhook" ? "webhook" : schedule ? "schedule" : vendor("scheduled_task"),
      native: schedule?.type,
      id: message.scheduledTaskId,
      runId: message.id.startsWith("scheduled-task-message:")
        ? message.id.slice("scheduled-task-message:".length)
        : undefined,
      // A current schedule can have changed since firing; do not backdate it onto the trigger.
    });
  }
  if (message.notification)
    return {
      kind: message.creationSource === "provider" ? "task_completion" : "event",
      native: message.notification.source.kind,
    };
  if (message.delegatedCompletion) return { kind: "task_completion" };
  if (
    message.senderThreadId &&
    message.creationSource === "mcp" &&
    intent !== "steer" &&
    intent !== "promoted_queued_to_steer"
  ) {
    return {
      kind: "peer",
      source: {
        session: sessionRef({ agent: "t3-code", namespace, sessionId: message.senderThreadId }),
      },
    };
  }
  return undefined;
}

function provenance(message: Message, intent?: string): Fields {
  const common = {
    via: ["web", "mobile"].includes(message.creationSource) ? message.creationSource : undefined,
  };
  if (message.scheduledTaskId || message.notification || message.idleCompaction)
    return { ...common, author: "harness", origin: "injected" };
  if (message.delegatedCompletion) return { ...common, author: "agent", origin: "subagent_report" };
  if (message.role === "assistant") return { author: "model" };
  const origin =
    intent === "queued_turn"
      ? "queued"
      : intent === "steer" || intent === "promoted_queued_to_steer"
        ? "steer"
        : "prompt";
  return fields({
    ...common,
    author: { user: "human", agent: "agent", system: "harness" }[message.createdBy],
    origin: message.senderThreadId && message.creationSource === "mcp" ? "inter_session" : origin,
  });
}

export function createThreadMapper(input: {
  source: ThreadSource;
  namespace: string;
  producerVersion: string;
  producerInstance: string;
  observedAt: string;
  schedules: Map<string, Fields>;
  mirror?: SessionKey;
  write: (record: AsrRecord) => void;
}) {
  const { source, namespace } = input;
  const items = new Map(source.items.map((item) => [item.id, item]));
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const messages = new Map(source.messages.map((message) => [message.id, message]));
  const runs = new Map(source.runs.map((run) => [run.id, run]));
  const attempts = new Map(source.attempts.map((attempt) => [attempt.id, attempt]));
  const providers = new Map(source.providerThreads.map((provider) => [provider.id, provider]));
  const providerTurns = new Map(source.providerTurns.map((turn) => [turn.id, turn]));
  const requestItems = new Map(
    source.items.flatMap((item) =>
      item.type === "approval_request" || item.type === "user_input_request"
        ? [[item.requestId, item] as const]
        : [],
    ),
  );
  const nodeItems = new Map(
    source.items.flatMap((item) => (item.nodeId ? [[item.nodeId, item] as const] : [])),
  );
  const handoffs = new Map(source.handoffs.map((handoff) => [handoff.id, handoff]));
  const callCounts = new Map<string, number>();
  for (const item of source.items)
    if (toolTypes.has(item.type))
      callCounts.set(callId(item), (callCounts.get(callId(item)) ?? 0) + 1);
  const representedMessages = new Set<string>();
  const handled = new Set<string>();
  const revisions = new Map<string, { id: string; json: string }>();
  const turnsSeen = new Set<string>();
  const runTriggers = new Map<string, Fields>();
  let seq = 0;
  let sourceEventId: string | undefined;
  let sourceItemId: string | undefined;
  const requestCommands = new Map<string, string>();
  let lastContext: string | null = null;
  const runPredecessors = new Map<string, string | null>();
  const references = new Map<string, SessionKey>();
  const addReference = (key: SessionKey): string => {
    const ref = sessionRef(key);
    references.set(ref, key);
    return ref;
  };
  const t3Reference = (id: string) => addReference({ agent: "t3-code", namespace, sessionId: id });
  const providerSession = (provider: ProviderThread | undefined, attempt?: Attempt) => {
    if (!provider) return input.mirror;
    if (attempt?.nativeThreadId)
      return nativeSession({
        driver: provider.driver,
        nativeId: attempt.nativeThreadId,
        strength: "strong",
      });
    if (sourceEventId) return undefined;
    const current = nativeSession(provider.nativeThreadRef);
    // Recovery can reuse a provider-thread row for a different native session.
    if (
      source.attempts.some(
        (entry) =>
          entry.providerThreadId === provider.id &&
          entry.nativeThreadId &&
          entry.nativeThreadId !== current?.sessionId,
      )
    )
      return undefined;
    return current;
  };
  const backing = (item: Item) => {
    const turn = item.providerTurnId ? providerTurns.get(item.providerTurnId) : undefined;
    const attempt = turn?.runAttemptId ? attempts.get(turn.runAttemptId) : undefined;
    const key = item.providerThreadId
      ? providerSession(providers.get(item.providerThreadId), attempt)
      : input.mirror;
    return key ? addReference(key) : undefined;
  };
  const copy = (item: Item) => {
    const session = backing(item);
    // Adapter item IDs do not necessarily name records in the native transcript.
    return session && item.nativeItemRef?.strength === "strong" && item.nativeItemRef.nativeId
      ? { copiedFrom: { session, proof: "native_field" } }
      : {};
  };
  const parentCall = (item: Item | undefined, nodeId?: string) => {
    const parent = item?.parentItemId ? items.get(item.parentItemId) : undefined;
    if (parent && toolTypes.has(parent.type)) return callId(parent);
    const node = nodeId ? nodes.get(nodeId) : item?.nodeId ? nodes.get(item.nodeId) : undefined;
    const parentNode = node?.parentNodeId ? nodes.get(node.parentNodeId) : undefined;
    const parentItem = parentNode ? nodeItems.get(parentNode.id) : undefined;
    return parentItem && toolTypes.has(parentItem.type) ? callId(parentItem) : undefined;
  };
  for (const run of source.runs) {
    const message = messages.get(run.userMessageId);
    const item = source.items.find(
      (candidate) => candidate.type === "user_message" && candidate.messageId === run.userMessageId,
    );
    const trigger = message
      ? triggerFor(
          message,
          item?.type === "user_message" ? item.inputIntent : undefined,
          input.schedules,
          namespace,
        )
      : undefined;
    if (trigger) runTriggers.set(run.id, trigger);
  }

  function emit(record: AsrRecord, key: string, revise = false) {
    const cleaned = fields({
      ...record,
      ...(sourceEventId ? {} : { assembly: snapshot }),
    }) as AsrRecord;
    const revisionKey = `${record.type}:${key}`;
    const previous = revisions.get(revisionKey);
    const json = JSON.stringify(cleaned);
    if (revise && previous?.json === json) return previous.id;
    const id = recordId(
      record.type,
      `${key}:${revise ? (sourceEventId ?? sourceItemId ?? "snapshot") : "snapshot"}`,
    );
    const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
    const trigger =
      turnId && !turnsSeen.has(turnId) && record.type !== "compaction"
        ? runTriggers.get(turnId)
        : undefined;
    if (turnId && record.type !== "compaction") turnsSeen.add(turnId);
    input.write({
      ...cleaned,
      id,
      seq: seq++,
      ...(trigger ? { trigger } : {}),
      ...(revise && previous ? { supersedes: previous.id } : {}),
    });
    if (revise) revisions.set(revisionKey, { id, json });
    if (
      ["message", "tool_call", "tool_result", "compaction"].includes(record.type) &&
      !(revise && previous)
    ) {
      if (turnId && !runPredecessors.has(turnId)) runPredecessors.set(turnId, lastContext);
      lastContext = id;
    }
    return id;
  }

  const executedBy = source.providerThreads.flatMap((provider) => {
    const key = nativeSession(provider.nativeThreadRef);
    return key ? [{ session: addReference(key), evidence: "native_field" }] : [];
  });
  for (const attempt of source.attempts) {
    if (!attempt.nativeThreadId) continue;
    const key = providerSession(providers.get(attempt.providerThreadId), attempt);
    if (key) executedBy.push({ session: addReference(key), evidence: "native_field" });
  }
  if (input.mirror)
    executedBy.push({ session: addReference(input.mirror), evidence: "native_field" });
  const parent = source.thread.lineage.parentThreadId;
  const relation = source.thread.lineage.relationshipToParent;
  const lineage: Fields = {
    executedBy: [...new Map(executedBy.map((entry) => [entry.session, entry])).values()],
  };
  if (
    source.created &&
    !parent &&
    !source.created.lineage.parentThreadId &&
    !source.created.forkedFrom &&
    source.created.historyOrigin === "native" &&
    source.thread.historyOrigin === "native" &&
    !input.mirror
  )
    lineage.root = true;
  if (parent) {
    lineage[
      relation === "fork" ? "forkedFrom" : relation === "subagent" ? "spawnedBy" : "relatedUnknown"
    ] = {
      session: t3Reference(parent),
      evidence: "native_field",
      ...(relation === "fork" && source.thread.forkedFrom?.type === "run"
        ? { record: `turnId=${source.thread.forkedFrom.runId}` }
        : {}),
    };
  }
  const losses = [
    "inference",
    "cost",
    "revision_history",
    "order",
    "tool_result.content",
    "tool_result.raw",
    "reasoning.signature",
    "reasoning.opaque",
    "provider.identity",
    "content.binary",
    "native",
    "copies",
    "exec.exit_code",
    "_codes.t3/tool_name",
    "_codes.t3/reasoning_visibility",
    "_codes.t3/approval_resolver",
    "_codes.t3/unmapped_metadata",
    "_codes.t3/continuation_history",
  ];
  if (
    source.providerThreads.some(
      (provider) => provider.nativeThreadRef && !nativeSession(provider.nativeThreadRef),
    )
  )
    losses.push("lineage");
  input.write({
    type: "session",
    seq: seq++,
    id: "header",
    observedAt: input.observedAt,
    formatVersion: "0.1",
    agent: { name: "t3-code" },
    namespace,
    sessionId: source.thread.id,
    producer: {
      name: "t3-code",
      version: input.producerVersion,
      method: "native",
      instance: input.producerInstance,
      source: { format: "t3code-statev2-sqlite" },
      lossy: losses,
    },
    startedAt: source.thread.createdAt,
    authority: input.mirror ? "mirror" : "local",
    scope: relation === "subagent" ? "subagent" : "primary",
    lineage,
    workspace: { roots: [{ id: "workspace", path: null }] },
    profiles: ["core", "coding", "lineage", "usage"],
    contentLevel: "full",
    extensions: [{ id: "codes.t3/export", version: "1", required: false }],
    _meta: meta({
      historyOrigin: source.thread.historyOrigin,
      contextTransfer: source.transfers,
      export: {
        order:
          "surviving audit events by sequence; snapshot tail: turn items by ordinal, then other current rows by table and rowid; no timestamp merge",
        snapshot: true,
      },
      nativeThreadRefs: source.providerThreads.map((provider) => ({
        id: provider.id,
        nativeThreadRef: provider.nativeThreadRef,
      })),
    }),
  });

  function messageRecord(message: Message, item?: Item) {
    if (representedMessages.has(message.id)) return;
    representedMessages.add(message.id);
    const intent = item?.type === "user_message" ? item.inputIntent : undefined;
    const display = [
      { type: "text", text: message.text },
      ...(message.context
        ? [{ type: "data", data: message.context, schema: "codes.t3/composerContext" }]
        : []),
      ...message.attachments.map((attachment) => ({
        type: "data",
        data: attachment,
        schema: "codes.t3/attachment",
      })),
    ];
    const isAssistant = message.role === "assistant";
    const run = message.runId ? runs.get(message.runId) : undefined;
    emit(
      {
        type: "message",
        messageId: message.id,
        idSource: "native",
        role: message.role,
        ...provenance(message, intent),
        turnId: message.runId,
        ts: message.updatedAt,
        assembly: snapshot,
        status:
          run?.status === "cancelled" && run.startedAt === null
            ? "withdrawn"
            : message.streaming
              ? "partial"
              : "complete",
        ...(isAssistant
          ? { content: text(message.text), ...(item ? copy(item) : {}) }
          : {
              content: [],
              displayContent: display,
              displayCorrespondence: "native",
              capture: { content: absent },
            }),
        ...(message.senderThreadId
          ? { from: { session: t3Reference(message.senderThreadId) } }
          : {}),
        _meta: meta({
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          workflowScript: message.workflowScript,
          dispatch: intent === undefined ? undefined : { inputIntent: intent },
          delegatedCompletion: message.delegatedCompletion,
          notification: message.notification,
        }),
      },
      message.id,
    );
  }

  function permission(
    request: RequestDetails,
    item: Extract<Item, { type: "approval_request" }> | undefined,
    ts?: string,
    commandId?: string,
  ) {
    const subjectCall = parentCall(item, request.nodeId);
    emit(
      {
        type: "permission",
        requestId: request.id,
        idSource: "native",
        turnId: item?.runId ?? nodes.get(request.nodeId ?? "")?.runId,
        ts,
        title: item?.title,
        description: item?.prompt,
        reason: item?.fullAccessOverride ?? item?.reason,
        ...(subjectCall ? { subject: { callId: subjectCall } } : {}),
        status:
          request.status === "cancelled"
            ? "resolved"
            : request.status === "resolved" && !request.decision
              ? vendor("resolved_without_decision")
              : request.status,
        decision:
          request.status === "cancelled"
            ? "cancelled"
            : request.decision
              ? decision(request.decision)
              : undefined,
        decidedAt: request.resolvedAt,
        feedback: request.feedback,
        // A receipt identifies the mechanism, never the human or agent behind it.
        _meta: meta({
          resolutionCommandId: commandId,
          responseCapability: request.responseCapability,
          permissionOptions: item?.options,
          permissionDecision: request.decision,
        }),
        options: item?.options?.map((option) => ({
          optionId: option.decision,
          name: option.label,
          ...(optionKind(option.decision) ? { kind: optionKind(option.decision) } : {}),
        })),
      },
      request.id,
      true,
    );
  }

  function question(
    request: RequestDetails,
    item: Extract<Item, { type: "user_input_request" }> | undefined,
    ts?: string,
    commandId?: string,
  ) {
    const answered = request.status === "resolved" || request.status === undefined;
    const answers = answered ? (request.answers ?? item?.questionAnswer?.answers) : undefined;
    const questions = item?.questions ?? [];
    const normalizedAnswers = questions.flatMap<Fields>((q) => {
      const answer = answers?.[q.id];
      if (typeof answer === "string") return [{ questionId: q.id, text: answer }];
      if (Array.isArray(answer) && answer.every((entry) => typeof entry === "string"))
        return [{ questionId: q.id, selected: answer }];
      return [];
    });
    emit(
      {
        type: "input_request",
        requestId: request.id,
        idSource: "native",
        mode: "questions",
        turnId: item?.runId ?? nodes.get(request.nodeId ?? "")?.runId,
        ts,
        callId: parentCall(item, request.nodeId),
        questions: questions.map((q) =>
          fields({
            id: q.id,
            header: q.header,
            text: q.question,
            options: q.options.map((option) =>
              fields({ label: option.label, value: option.value, description: option.description }),
            ),
            multiSelect: q.multiSelect,
            allowOther: q.allowCustomAnswer,
          }),
        ),
        ...(item ? {} : { capture: { questions: absent } }),
        status:
          request.status === "resolved"
            ? "answered"
            : request.status === "expired"
              ? "timed_out"
              : request.status,
        blocking:
          item?.responseMode === "message" || request.responseCapability?.type === "message"
            ? false
            : undefined,
        ...(answers === undefined ? {} : { answers: normalizedAnswers }),
        ...(sourceEventId && answers
          ? { native: { format: "t3code-statev2-sqlite", record: request } }
          : {}),
        _meta: meta({
          responseCapability: request.responseCapability,
          resolutionCommandId: commandId,
          previews: Object.fromEntries(
            questions.map((q) => [
              q.id,
              q.options.flatMap((option) =>
                option.preview === undefined
                  ? []
                  : [{ label: option.label, preview: option.preview }],
              ),
            ]),
          ),
          required: questions.filter((q) => q.required).map((q) => q.id),
          initialAnswers: Object.fromEntries(
            questions.flatMap((q) =>
              q.initialAnswer === undefined ? [] : [[q.id, q.initialAnswer]],
            ),
          ),
          attachmentAnswers: answered ? item?.questionAnswer?.attachmentsByQuestionId : undefined,
        }),
      },
      request.id,
      true,
    );
  }

  function requestRecord(request: Request, ts?: string, commandId?: string) {
    handled.add(`request:${request.id}`);
    if (commandId) requestCommands.set(request.id, commandId);
    const item = sourceEventId ? undefined : requestItems.get(request.id);
    if (request.kind === "user_input" || item?.type === "user_input_request")
      question(request, item?.type === "user_input_request" ? item : undefined, ts, commandId);
    else if (
      ["command", "file-read", "file-change", "permission"].includes(request.kind) ||
      item?.type === "approval_request"
    )
      permission(request, item?.type === "approval_request" ? item : undefined, ts, commandId);
    else
      emit(
        {
          type: "codes.t3/runtime_request",
          requestId: request.id,
          kind: request.kind,
          status: request.status,
          ts,
          _meta: meta({ responseCapability: request.responseCapability }),
        },
        request.id,
        true,
      );
  }

  function subagentRecord(child: Subagent, ts?: string) {
    handled.add(`subagent:${child.id}`);
    const item = nodeItems.get(child.id);
    emit(
      {
        type: "subagent",
        turnId: child.runId,
        ts,
        childSession: child.childThreadId ? t3Reference(child.childThreadId) : undefined,
        ...(child.childThreadId ? {} : { capture: { childSession: absent } }),
        callId: parentCall(item, child.id),
        description: child.prompt,
        agent: agentName(child.driver),
        model: child.modelSelection
          ? { id: child.modelSelection.model }
          : child.model
            ? { id: child.model }
            : undefined,
        status:
          child.status === "cancelled" || child.status === "interrupted"
            ? "stopped"
            : ["running", "completed", "failed"].includes(child.status)
              ? child.status
              : undefined,
        _meta: meta({
          nativeTaskRef: child.nativeTaskRef,
          subagent: fields({
            status: child.status,
            origin: child.origin,
            completionWake: child.completionWake,
            completionDelivery: child.completionDelivery,
            progress: child.progress,
            workflow: child.workflow,
            result: child.result,
          }),
        }),
      },
      child.id,
      true,
    );
  }

  function checkpointRecord(checkpoint: Checkpoint, ts?: string) {
    handled.add(`checkpoint:${checkpoint.id}`);
    const scope = sourceEventId
      ? undefined
      : source.scopes.find((entry) => entry.id === checkpoint.scopeId);
    emit(
      {
        type: "checkpoint",
        kind: "git_ref",
        ref: checkpoint.ref,
        status: checkpoint.status,
        turnId: checkpoint.runId,
        ts: ts ?? checkpoint.capturedAt,
        root: "workspace",
        files: checkpoint.files.map((file) => ({ path: file.path })),
        _meta: meta({
          scope,
          fileStats: checkpoint.files.map((file) =>
            fields({ path: file.path, additions: file.additions, deletions: file.deletions }),
          ),
        }),
      },
      checkpoint.id,
      true,
    );
  }

  function execution(
    provider: ProviderThread | undefined,
    turn?: ProviderTurn,
    attempt?: Attempt,
  ): Fields {
    const ref = providerSession(provider, attempt);
    return fields({
      executedBy: ref
        ? {
            session: addReference(ref),
            ...(turn?.nativeTurnRef?.driver === "codex" &&
            turn.nativeTurnRef.strength === "strong" &&
            turn.nativeTurnRef.nativeId
              ? { turnId: turn.nativeTurnRef.nativeId }
              : {}),
          }
        : undefined,
      _meta: meta({
        nativeThreadRef: provider?.nativeThreadRef,
        nativeTurnRef: turn?.nativeTurnRef,
      }),
    });
  }

  function runRecord(run: Run, ts?: string) {
    handled.add(`run:${run.id}`);
    if (run.status === "rolled_back") {
      if (handled.has(`rollback:${run.id}`)) return;
      handled.add(`rollback:${run.id}`);
      const to = runPredecessors.get(run.id);
      if (to !== undefined) emit({ type: "rewind", to, reason: "rollback", ts }, run.id);
      else emit({ type: "codes.t3/rollback", turnId: run.id, ts, status: run.status }, run.id);
      return;
    }
    // Do not use an attempt's final snapshot to fill an earlier run transition.
    emit(
      {
        type: "state",
        turnId: run.id,
        ts,
        ...runState(run.status),
        continuationOf: run.restartContinuationOfRunId
          ? `turnId=${run.restartContinuationOfRunId}`
          : undefined,
        _meta: meta({
          runStatus: run.status,
          run: fields({
            queuePosition: run.queuePosition,
            queueHeld: run.queueHeld,
            workspacePreparation: run.workspacePreparation,
            sourcePlanRef: run.sourcePlanRef,
            delegatedTaskId: run.delegatedTaskId,
          }),
        }),
      },
      run.id,
      true,
    );
  }

  function attemptRecord(attempt: Attempt, ts?: string) {
    handled.add(`attempt:${attempt.id}`);
    const provider = providers.get(attempt.providerThreadId);
    const turn =
      !sourceEventId && attempt.providerTurnId
        ? providerTurns.get(attempt.providerTurnId)
        : undefined;
    emit(
      {
        type: "state",
        turnId: attempt.runId,
        ts,
        ...runState(attempt.status),
        attempt: { n: attempt.attemptOrdinal, reason: attempt.reason },
        ...execution(provider, turn, attempt),
        _meta: meta({
          attemptStatus: attempt.status,
          nativeThreadRef: sourceEventId ? undefined : provider?.nativeThreadRef,
          nativeTurnRef: turn?.nativeTurnRef,
        }),
      },
      attempt.id,
      true,
    );
  }

  function tool(item: Item) {
    const id = callId(item);
    const base = { turnId: item.runId, assembly: snapshot };
    const isDynamic = item.type === "dynamic_tool";
    const name = isDynamic ? item.toolName : undefined;
    const args =
      item.type === "command_execution"
        ? { inputText: item.input }
        : isDynamic
          ? source.inputTexts.has(item.id)
            ? { inputText: source.inputTexts.get(item.id) }
            : { input: item.input }
          : item.type === "file_search"
            ? { input: fields({ pattern: item.pattern }) }
            : item.type === "web_search"
              ? { input: fields({ patterns: item.patterns }) }
              : { capture: { input: absent } };
    emit(
      {
        type: "tool_call",
        ...base,
        ts: item.startedAt,
        callId: id,
        callIdSource: "native",
        name,
        kind:
          item.type === "command_execution"
            ? "execute"
            : item.type === "file_change"
              ? "edit"
              : item.type === "file_search"
                ? "search"
                : undefined,
        title: item.title,
        ...args,
        capture: { ...("capture" in args ? args.capture : {}), ...(name ? {} : { name: absent }) },
        parentCallId: parentCall(item),
        ...(isDynamic && item.toolSource?.kind === "integration"
          ? { provider: { kind: "connector", name: item.toolSource.name, identity: "exact" } }
          : name?.startsWith("mcp__")
            ? { provider: { kind: "mcp", identity: "unknown" } }
            : {}),
        ...copy(item),
      },
      item.id,
    );
    if (!terminalStatuses.has(item.status)) return;
    const output = "output" in item ? item.output : "results" in item ? item.results : undefined;
    emit(
      {
        type: "tool_result",
        ...base,
        ts: item.completedAt,
        ...((callCounts.get(id) ?? 0) > 1
          ? { linkage: "ambiguous" }
          : { callId: id, linkage: "exact" }),
        _meta: meta({ nativeItemRef: item.nativeItemRef }),
        status: item.status,
        capture: {
          content: absent,
          ...("outputOmitted" in item && item.outputOmitted
            ? { displayContent: { state: "omitted", reason: "source_truncated" } }
            : {}),
        },
        ...(output === undefined || ("outputOmitted" in item && item.outputOmitted)
          ? {}
          : {
              displayContent:
                typeof output === "string" ? text(output) : [{ type: "data", data: output }],
            }),
        ...(item.type === "command_execution"
          ? {
              exec: fields({
                command: item.input,
                exitCode: item.exitCode,
                output: item.outputOmitted ? undefined : item.output,
              }),
            }
          : {}),
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        ...copy(item),
      },
      item.id,
    );
    if (item.type === "file_change") {
      const details = (item.changes ?? []).filter(
        (change) =>
          ![change.path, change.oldPath].some((path) =>
            path?.replaceAll("\\", "/").split("/").includes(".."),
          ),
      );
      const changes = details.map((change) => ({
        op: change.oldPath ? "move" : change.operation === "update" ? "modify" : change.operation,
        ...pathRef(change.path),
        ...(change.oldPath
          ? { oldPath: pathRef(change.oldPath).path, oldRoot: pathRef(change.oldPath).root }
          : {}),
        ...fields({
          fileType: "fileType" in change ? change.fileType : undefined,
          mimeType: "mimeType" in change ? change.mimeType : undefined,
        }),
      }));
      if (changes.length)
        emit(
          {
            type: "file_change",
            ...base,
            ts: item.completedAt,
            cause: { callId: id },
            status:
              item.status === "completed"
                ? "applied"
                : item.status === "failed"
                  ? "failed"
                  : "unknown",
            precision: item.diffStr ? "hunks" : "unknown",
            changes,
            ...(item.diffStr
              ? {
                  patch: {
                    format: changes.length === 1 ? "unified" : "git_patch",
                    text: item.diffStr,
                  },
                }
              : { capture: { patch: absent } }),
            ...copy(item),
            _meta: meta({
              edit: fields({
                oldStr: item.oldStr,
                newStr: item.newStr,
                additions: item.additions,
                deletions: item.deletions,
              }),
            }),
          },
          item.id,
        );
      if (!changes.length || changes.length !== item.changes?.length)
        emit(
          {
            type: "codes.t3/file_edit",
            ...base,
            ts: item.completedAt,
            fileName: item.fileName,
            changes: item.changes,
            diffStr: item.diffStr,
            oldStr: item.oldStr,
            newStr: item.newStr,
          },
          item.id,
        );
    }
  }

  function pathRef(path: string): { root: string | null; path: string; nativePath?: string } {
    const normalized = NodePath.posix.normalize(path.replaceAll("\\", "/"));
    const absolute = /^(?:\/|[A-Za-z]:\/)/u.test(normalized);
    return {
      root: absolute ? null : "workspace",
      path: normalized,
      ...(normalized === path ? {} : { nativePath: path }),
    };
  }

  function handoffRecord(handoff: Handoff) {
    handled.add(`handoff:${handoff.id}`);
    if (
      !handoff.summaryText ||
      !handoff.delivery ||
      handoff.delivery.status === "pending" ||
      (handoff.summaryMessageId && messages.has(handoff.summaryMessageId))
    )
      return;
    emit(
      {
        type: "message",
        messageId: handoff.summaryMessageId ?? `handoff:${handoff.id}`,
        idSource: handoff.summaryMessageId ? "native" : "derived",
        turnId: handoff.targetRunId,
        ts: handoff.updatedAt,
        role: "user",
        author: "harness",
        origin: "injected",
        content: text(handoff.summaryText),
        assembly: snapshot,
        _meta: meta({
          handoff: {
            strategy: handoff.strategy,
            history: handoff.history,
            delivery: handoff.delivery,
          },
        }),
      },
      handoff.id,
    );
  }

  function itemRecord(item: Item) {
    sourceItemId = item.id;
    const base = { turnId: item.runId, ts: item.updatedAt, assembly: snapshot };
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message = messages.get(item.messageId);
      if (message) messageRecord(message, item);
      else
        emit(
          {
            type: "message",
            ...base,
            messageId: item.messageId,
            role: item.type === "user_message" ? "user" : "assistant",
            content: [],
            displayContent: text(item.text),
            capture: { content: absent },
            displayCorrespondence: "native",
          },
          item.messageId,
        );
    } else if (item.type === "reasoning") {
      emit(
        {
          type: "message",
          ...base,
          messageId:
            item.nativeItemRef?.strength === "strong" && item.nativeItemRef.nativeId
              ? item.nativeItemRef.nativeId
              : item.id,
          role: "assistant",
          author: "model",
          content: [{ type: "reasoning", text: item.text }],
          status: item.streaming ? "partial" : "complete",
          ...copy(item),
        },
        item.id,
      );
    } else if (
      item.type === "command_execution" &&
      item.title === "Workspace ready" &&
      !item.nativeItemRef
    ) {
      emit(
        {
          type: "hook",
          ...base,
          event: "workspace_setup",
          handlerKind: "command",
          name: item.title,
          command: item.input,
          status: ["completed", "failed", "cancelled"].includes(item.status)
            ? item.status
            : "unknown",
          _meta: meta({ hookStatus: item.status }),
          exitCode: item.exitCode,
          output: item.output === undefined ? undefined : text(item.output),
        },
        item.id,
      );
    } else if (toolTypes.has(item.type)) tool(item);
    else if (
      item.type === "approval_request" &&
      !source.requests.some((request) => request.id === item.requestId)
    )
      permission({ id: item.requestId }, item, item.updatedAt);
    else if (
      item.type === "user_input_request" &&
      !source.requests.some((request) => request.id === item.requestId)
    )
      question({ id: item.requestId }, item, item.updatedAt);
    else if (item.type === "secret_request") {
      emit(
        {
          type: "input_request",
          ...base,
          requestId: item.id,
          idSource: "native",
          mode: "questions",
          secret: true,
          questions: [{ id: "secret", text: item.label, secret: true }],
          status: item.secretStatus === "saved" ? "answered" : item.secretStatus,
          _meta: meta({
            secretRequest: fields({
              label: item.label,
              reason: item.reason,
              placeholder: item.placeholder,
              delivery: item.delivery,
            }),
          }),
        },
        item.id,
      );
    } else if (item.type === "compaction") {
      emit(
        {
          type: "compaction",
          ...base,
          compactionId: item.id,
          kind: vendor("compaction"),
          replaces: { state: "unknown" },
          reason: item.runId
            ? messages.get(runs.get(item.runId)?.userMessageId ?? "")?.idleCompaction
            : undefined,
          status:
            item.status === "running"
              ? "in_progress"
              : terminalStatuses.has(item.status)
                ? item.status
                : undefined,
          ...(item.summary === undefined
            ? { capture: { summary: absent } }
            : { summary: text(item.summary) }),
          tokens: fields({ before: item.beforeTokenCount, after: item.afterTokenCount }),
        },
        item.id,
      );
    } else if (item.type === "todo_list" || item.type === "proposed_plan") {
      emit(
        {
          type: "plan",
          ...base,
          planId: item.planId,
          planType: item.type === "todo_list" ? "items" : "document",
          ...(item.type === "todo_list"
            ? {
                entries: item.steps.map((step) => ({
                  entryId: step.id,
                  content: step.text,
                  status: step.status === "running" ? "in_progress" : step.status,
                })),
                _meta: meta({ planExplanation: item.explanation }),
              }
            : { content: text(item.markdown) }),
        },
        item.planId,
        true,
      );
    } else if (
      item.type === "notification" ||
      item.type === "system_notice" ||
      item.type === "run_interrupt_request" ||
      item.type === "run_interrupt_result"
    ) {
      emit(
        {
          type: "message",
          ...base,
          messageId: item.id,
          author: "harness",
          origin: "notice",
          audience: "user",
          content: [],
          displayContent: text(item.type === "notification" ? item.summary : item.message),
          displayCorrespondence: "native",
          capture: { role: absent, content: absent },
          _meta:
            item.type === "notification"
              ? meta({
                  notification: { source: item.source, outcome: item.outcome, detail: item.detail },
                })
              : undefined,
        },
        item.id,
      );
    } else if (item.type === "error") {
      emit(
        {
          type: "state",
          ...base,
          state: "error",
          error: {
            ...fields(item.failure),
            ...(item.retry
              ? {
                  retry: fields({
                    attempt: item.retry.attempt,
                    maxAttempts: item.retry.maxAttempts,
                    delayMs: item.retry.retryDelayMs,
                  }),
                }
              : {}),
          },
        },
        item.id,
      );
    } else if (item.type === "handoff") {
      const handoff = handoffs.get(item.contextHandoffId);
      if (handoff) handoffRecord(handoff);
    } else if (item.type === "thread_created") {
      emit(
        {
          type: "codes.t3/thread_created",
          ...base,
          childSession: t3Reference(item.targetThreadId),
          model: item.targetModel,
        },
        item.id,
      );
    }
  }

  function eventRecord(stored: StoredEvent) {
    const { event } = stored;
    sourceEventId = event.id;
    const ts = event.occurredAt;
    switch (event.type) {
      case "run.created":
        emit(
          {
            type: "config_change",
            turnId: event.payload.id,
            ts,
            snapshot: true,
            model: { id: event.payload.modelSelection.model },
            options: modelOptions(event.payload.modelSelection.options),
          },
          `config:${event.id}`,
        );
        runRecord(event.payload, ts);
        break;
      case "run.updated":
        runRecord(event.payload, ts);
        break;
      case "run-attempt.created":
      case "run-attempt.updated":
        attemptRecord(event.payload, ts);
        break;
      case "runtime-request.updated":
        requestRecord(event.payload, ts, stored.commandId);
        break;
      case "subagent.updated":
        subagentRecord(event.payload, ts);
        break;
      case "checkpoint.captured":
        checkpointRecord(event.payload, ts);
        break;
      case "thread.pull-request-link-updated": {
        const link = event.payload;
        handled.add(`pr:${link.url}`);
        emit(
          {
            type: "vcs",
            ts,
            action: link.source === "created" ? "pr_open" : "pr_link",
            evidence: link.source === "created" ? "observed" : "reported",
            pr: { url: link.url, number: link.number, repository: link.repository },
            _meta: meta({ prLink: link, prWatch: link.watch }),
          },
          link.url,
          true,
        );
        break;
      }
      case "provider-session.attached":
      case "provider-session.updated":
      case "provider-session.detached":
        emit(
          { type: "codes.t3/provider_session", ts, event: event.type, payload: event.payload },
          event.id,
        );
        break;
      case "checkpoint.rollback-requested":
        emit({ type: "codes.t3/rollback_request", ts, payload: event.payload }, event.id);
        break;
      case "thread.model-selection-updated":
      case "thread.runtime-mode-updated":
      case "thread.interaction-mode-updated":
      case "thread.provider-switched":
        emit(
          {
            type: "config_change",
            ts,
            model: { id: event.payload.modelSelection.model },
            permissionMode: event.payload.runtimeMode,
            mode: event.payload.interactionMode,
            options: modelOptions(event.payload.modelSelection.options),
          },
          event.id,
        );
        break;
      default:
        break;
    }
    sourceEventId = undefined;
  }

  function finish() {
    sourceItemId = undefined;
    for (const message of source.messages.filter((entry) => !representedMessages.has(entry.id)))
      messageRecord(message);
    for (const request of source.requests)
      requestRecord(
        request,
        request.resolvedAt ?? request.createdAt,
        requestCommands.get(request.id),
      );
    for (const child of source.subagents) subagentRecord(child, child.updatedAt);
    for (const checkpoint of source.checkpoints) checkpointRecord(checkpoint);
    for (const run of source.runs) runRecord(run);
    for (const attempt of source.attempts) attemptRecord(attempt);
    for (const handoff of source.handoffs)
      if (!handled.has(`handoff:${handoff.id}`)) handoffRecord(handoff);
    for (const provider of source.providerThreads) {
      if (provider.nativeThreadRef)
        emit(
          {
            type: "codes.t3/provider_identity",
            _meta: meta({ nativeThreadRef: provider.nativeThreadRef }),
          },
          provider.id,
        );
      if (provider.goal)
        emit(
          {
            type: "plan",
            planId: `goal:${provider.id}`,
            idSource: "derived",
            planType: "goal",
            assembly: snapshot,
            content: text(provider.goal.objective),
            status: provider.goal.status,
            budget: fields({ tokens: provider.goal.tokenBudget }),
            used: fields({
              tokens: provider.goal.tokensUsed,
              seconds: provider.goal.timeUsedSeconds,
            }),
            _meta: meta({
              goalChecks: fields({
                checks: provider.goal.checks,
                lastCheck: provider.goal.lastCheck,
              }),
            }),
          },
          `goal:${provider.id}`,
        );
      for (const task of provider.pendingBackgroundTasks ?? []) {
        if (task.kind === "command" || task.kind === "monitor")
          emit(
            {
              type: "terminal",
              terminalId: task.taskId,
              kind: task.kind === "command" ? "shell" : "monitor",
              awaited: task.awaited,
              assembly: snapshot,
              _meta: meta({ backgroundTasks: task }),
            },
            `${provider.id}:${task.taskId}`,
          );
        else
          emit(
            {
              type: "state",
              state: vendor("background_work"),
              assembly: snapshot,
              _meta: meta({ backgroundTasks: task }),
            },
            `${provider.id}:${task.taskId}`,
          );
      }
    }
    type UsageGroup = { runId: string | null | undefined; turns: ProviderTurn[] };
    const usageGroups = new Map<string, UsageGroup>();
    for (const turn of source.providerTurns) {
      const attempt = turn.runAttemptId ? attempts.get(turn.runAttemptId) : undefined;
      const runId = attempt?.runId ?? nodes.get(turn.nodeId)?.runId;
      if (runId)
        emit(
          {
            type: "state",
            turnId: runId,
            ...runState(turn.status),
            ...execution(providers.get(turn.providerThreadId), turn, attempt),
            assembly: snapshot,
          },
          turn.id,
        );
      const key = runId ?? `provider-turn:${turn.id}`;
      const group: UsageGroup = usageGroups.get(key) ?? { runId, turns: [] };
      group.turns.push(turn);
      usageGroups.set(key, group);
    }
    for (const [key, group] of usageGroups) {
      const usages = group.turns.map((turn) => turn.turnTokenUsage);
      const context = group.turns
        .flatMap((turn) => (turn.tokenUsage ? [turn.tokenUsage] : []))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .at(-1);
      if (!usages.some(Boolean) && !context) continue;
      const sum = (
        field:
          | "inputTokens"
          | "outputTokens"
          | "cachedInputTokens"
          | "cacheCreationTokens"
          | "reasoningTokens",
      ) => {
        const values = usages.flatMap((usage) =>
          usage?.[field] === undefined ? [] : [usage[field]],
        );
        const total = values.reduce((a, b) => a + b, 0);
        return values.length && Number.isSafeInteger(total) ? total : undefined;
      };
      const inputTokens = sum("inputTokens");
      const runAttempts = source.attempts.filter((attempt) => attempt.runId === group.runId);
      const complete =
        usages.every((usage) => usage?.usageStatus === "complete") &&
        runAttempts.length > 0 &&
        runAttempts.every((attempt) =>
          group.turns.some((turn) => turn.id === attempt.providerTurnId),
        );
      emit(
        {
          type: "usage_summary",
          turnId: group.runId,
          scope: group.runId ? "turn" : vendor("provider_turn"),
          cumulative: false,
          includesChildren: false,
          coverage: "partial",
          assembly: snapshot,
          ...(usages.some(Boolean)
            ? {
                usage: {
                  input: fields({
                    total: inputTokens,
                    includesCache: inputTokens === undefined ? undefined : true,
                    cacheRead: sum("cachedInputTokens"),
                    cacheWrite: sum("cacheCreationTokens"),
                  }),
                  output: fields({ total: sum("outputTokens"), reasoning: sum("reasoningTokens") }),
                },
              }
            : {}),
          ...(context
            ? { contextWindow: fields({ used: context.usedTokens, size: context.maxTokens }) }
            : {}),
          _meta: meta({
            providerUsage: group.turns.flatMap((turn) =>
              turn.turnTokenUsage
                ? [{ providerTurnId: turn.id, turnTokenUsage: turn.turnTokenUsage }]
                : [],
            ),
            providerTurns: group.turns.map((turn) =>
              fields({
                id: turn.id,
                nativeTurnRef: turn.nativeTurnRef,
                context: turn.tokenUsage,
              }),
            ),
            usageStatus: { coverage: complete ? "complete" : "partial" },
            promptCache: context
              ? fields({
                  promptCacheTtlMs: context.promptCacheTtlMs,
                  promptCacheExpiresAt: context.promptCacheExpiresAt,
                  autoCompactThreshold: context.autoCompactThreshold,
                })
              : undefined,
          }),
        },
        key,
      );
    }
    for (const link of source.thread.pullRequests ?? [])
      if (!handled.has(`pr:${link.url}`))
        emit(
          {
            type: "vcs",
            action: "pr_link",
            evidence: "reported",
            assembly: snapshot,
            pr: { url: link.url, number: link.number, repository: link.repository },
            _meta: meta({ prLink: link, prWatch: link.watch }),
          },
          link.url,
        );
    emit(
      {
        type: "session_info",
        ts: source.thread.updatedAt,
        title: source.thread.title,
        project: { id: source.thread.projectId },
        flags: [
          ...(source.thread.archivedAt ? ["archived"] : []),
          ...(source.thread.pinnedAt ? ["pinned"] : []),
          ...(source.thread.deletedAt ? ["deleted"] : []),
        ],
        assembly: snapshot,
        _meta: meta({
          inbox: fields({
            settled: source.thread.settledAt,
            snoozedUntil: source.thread.snoozedUntil,
            lastVisitedAt: source.thread.lastVisitedAt,
            pinOrderKey: source.thread.pinOrderKey,
          }),
          workspace: fields({
            worktreePath: source.thread.worktreePath,
            branch: source.thread.branch,
          }),
        }),
      },
      source.thread.id,
    );
    emit(
      {
        type: "config_change",
        ts: source.thread.updatedAt,
        snapshot: true,
        model: { id: source.thread.modelSelection.model },
        permissionMode: source.thread.runtimeMode,
        mode: source.thread.interactionMode,
        options: modelOptions(source.thread.modelSelection.options),
      },
      source.thread.id,
    );
    return { recordCount: seq, references: [...references.values()] };
  }

  return { item: itemRecord, event: eventRecord, finish };
}

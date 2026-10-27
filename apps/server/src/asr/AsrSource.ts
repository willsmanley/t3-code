import type * as NodeSqlite from "node:sqlite";

import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2CheckpointJson,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2ContextTransferJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type Item = typeof OrchestrationV2TurnItemJson.Encoded;
export type Message = typeof OrchestrationV2ConversationMessageJson.Encoded;
export type Thread = typeof OrchestrationV2AppThreadJson.Encoded;
export type Run = typeof OrchestrationV2RunJson.Encoded;
export type Attempt = typeof OrchestrationV2RunAttemptJson.Encoded;
export type ProviderThread = typeof OrchestrationV2ProviderThreadJson.Encoded;
export type ProviderTurn = typeof OrchestrationV2ProviderTurnJson.Encoded;
export type Request = typeof OrchestrationV2RuntimeRequestJson.Encoded;
export type Subagent = typeof OrchestrationV2SubagentJson.Encoded;
export type Checkpoint = typeof OrchestrationV2CheckpointJson.Encoded;
export type Handoff = typeof OrchestrationV2ContextHandoffJson.Encoded;
export type Event = typeof OrchestrationV2DomainEventJson.Encoded;

const decoders = new WeakMap<Schema.Constraint, (value: unknown) => unknown>();

function unsafeNumber(value: unknown): boolean {
  if (typeof value === "number")
    return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
  return value !== null && typeof value === "object" && Object.values(value).some(unsafeNumber);
}

function decode<S extends Schema.Constraint>(
  schema: S,
  json: unknown,
  inputTexts?: Map<string, string>,
): S["Encoded"] {
  let decoder = decoders.get(schema);
  if (!decoder) {
    decoder = Schema.decodeUnknownSync(Schema.toEncoded(schema));
    decoders.set(schema, decoder);
  }
  if (typeof json !== "string") throw new Error("Expected a persisted JSON string.");
  const parsed: unknown = JSON.parse(json);
  if (unsafeNumber(parsed)) {
    if (
      inputTexts &&
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "dynamic_tool" &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      "input" in parsed &&
      unsafeNumber(parsed.input)
    ) {
      const rawJSON = (JSON as typeof JSON & { rawJSON: (source: string) => unknown }).rawJSON;
      const lossless = JSON.parse(json, (_key, value: unknown, context?: { source?: string }) => {
        if (typeof value === "number" && unsafeNumber(value)) {
          if (!context?.source || !Number.isFinite(value))
            throw new Error("Unsupported non-finite source number.");
          return rawJSON(context.source);
        }
        return value;
      });
      inputTexts.set(parsed.id, JSON.stringify(lossless.input));
      parsed.input = null;
    }
    if (unsafeNumber(parsed))
      throw new Error("Unsupported unsafe source number outside tool arguments.");
  }
  return decoder(parsed) as S["Encoded"];
}

export function readThreads(database: NodeSqlite.DatabaseSync, threadId?: string): Thread[] {
  const rows =
    threadId === undefined
      ? database
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id",
          )
          .all()
      : database
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?",
          )
          .all(threadId);
  return rows.map((row) => decode(OrchestrationV2AppThreadJson, row.payload_json));
}

export function readThreadSource(database: NodeSqlite.DatabaseSync, thread: Thread) {
  const inputTexts = new Map<string, string>();
  const read = <S extends Schema.Constraint>(table: string, schema: S): S["Encoded"][] =>
    database
      .prepare(
        `SELECT payload_json FROM orchestration_v2_projection_${table} WHERE thread_id = ? ORDER BY rowid`,
      )
      .all(thread.id)
      .map((row) =>
        decode(schema, row.payload_json, table === "turn_items" ? inputTexts : undefined),
      );
  return {
    thread,
    created: (() => {
      const row = database
        .prepare(
          "SELECT payload_json FROM orchestration_events WHERE stream_id = ? AND aggregate_kind = 'thread' AND application_event_version = 2 AND event_type = 'thread.created' ORDER BY sequence LIMIT 1",
        )
        .get(thread.id);
      return row ? decode(OrchestrationV2AppThreadJson, row.payload_json) : undefined;
    })(),
    items: read("turn_items", OrchestrationV2TurnItemJson).sort((a, b) => a.ordinal - b.ordinal),
    inputTexts,
    messages: read("messages", OrchestrationV2ConversationMessageJson),
    runs: read("runs", OrchestrationV2RunJson),
    attempts: read("run_attempts", OrchestrationV2RunAttemptJson),
    nodes: read("nodes", OrchestrationV2ExecutionNodeJson),
    subagents: read("subagents", OrchestrationV2SubagentJson),
    providerThreads: read("provider_threads", OrchestrationV2ProviderThreadJson),
    providerTurns: read("provider_turns", OrchestrationV2ProviderTurnJson),
    requests: read("runtime_requests", OrchestrationV2RuntimeRequestJson),
    checkpoints: read("checkpoints", OrchestrationV2CheckpointJson),
    scopes: read("checkpoint_scopes", OrchestrationV2CheckpointScopeJson),
    handoffs: read("context_handoffs", OrchestrationV2ContextHandoffJson),
    transfers: database
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_context_transfers WHERE source_thread_id = ? OR target_thread_id = ? ORDER BY rowid",
      )
      .all(thread.id, thread.id)
      .map((row) => decode(OrchestrationV2ContextTransferJson, row.payload_json)),
  };
}

export type ThreadSource = ReturnType<typeof readThreadSource>;

export interface StoredEvent {
  sequence: number;
  commandId?: string;
  event: Event;
}

// Mutable item bodies come from projections in the capture tail, never audit-event positions.
export function* readEvents(
  database: NodeSqlite.DatabaseSync,
  threadId: string,
): Generator<StoredEvent> {
  const rows = database
    .prepare(`
    SELECT sequence, event_id, event_type, occurred_at, command_id, metadata_json,
      CASE WHEN event_type = 'subagent.updated' AND json_type(payload_json, '$.promptSequence') = 'integer'
        THEN json_set(json_remove(payload_json, '$.promptSequence'), '$.prompt',
          (SELECT json_extract(anchor.payload_json, '$.prompt') FROM orchestration_events anchor
           WHERE anchor.sequence = json_extract(orchestration_events.payload_json, '$.promptSequence')))
        ELSE payload_json END AS payload_json
    FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ? AND application_event_version = 2
      AND event_type NOT IN ('turn-item.updated', 'node.updated', 'message.updated', 'provider-thread.updated', 'provider-turn.updated',
        'plan.updated', 'checkpoint-scope.created', 'context-handoff.updated', 'context-transfer.created', 'context-transfer.updated')
    ORDER BY sequence
  `)
    .iterate(threadId);
  for (const row of rows) {
    const metadata = typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : {};
    const event = decode(
      OrchestrationV2DomainEventJson,
      JSON.stringify({
        ...metadata,
        id: row.event_id,
        type: row.event_type,
        threadId,
        occurredAt: row.occurred_at,
        payload: JSON.parse(String(row.payload_json)),
      }),
    );
    yield {
      sequence: Number(row.sequence),
      ...(typeof row.command_id === "string" ? { commandId: row.command_id } : {}),
      event,
    };
  }
}

export function readSchedules(database: NodeSqlite.DatabaseSync) {
  const schedules = new Map<string, Record<string, unknown>>();
  if (
    !database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'")
      .get()
  )
    return schedules;
  // Never select webhook_token, webhook_secret, delivery headers, or request bodies.
  for (const row of database.prepare("SELECT task_id, schedule_json FROM scheduled_tasks").all()) {
    const parsed: unknown = JSON.parse(String(row.schedule_json));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const schedule = parsed as Record<string, unknown>;
      schedules.set(
        String(row.task_id),
        schedule.type === "webhook" ? { type: "webhook" } : schedule,
      );
    }
  }
  return schedules;
}

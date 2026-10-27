// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The offline export owns a read-only SQLite snapshot and writes bounded synchronous file buffers.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { createThreadMapper, nativeSession, sessionRef, type SessionKey } from "./AsrMapping.ts";
import { readEvents, readSchedules, readThreadSource, readThreads } from "./AsrSource.ts";

export class AsrExportError extends Schema.TaggedError<AsrExportError>()("AsrExportError", {
  stage: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `ASR export failed during ${this.stage}. No complete bundle was published.`;
  }
}

const isAsrExportError = Schema.is(AsrExportError);

export interface ExportOptions {
  readonly userdata: string;
  readonly output: string;
  readonly threadId?: string;
}

export interface ExportSummary {
  readonly threads: number;
  readonly records: number;
  readonly bytes: number;
  readonly referencedSessions: number;
  readonly sourceSequence: number;
}

export class AsrExport extends Context.Service<
  AsrExport,
  {
    readonly exportBundle: (options: ExportOptions) => Effect.Effect<ExportSummary, AsrExportError>;
  }
>()("t3/asr/AsrExport") {}

function writeAll(fd: number, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) offset += NodeFS.writeSync(fd, buffer, offset);
}

// No per-record Effect or filesystem promises: the offline CLI streams bounded buffers to one file.
function exportSnapshot(options: ExportOptions): ExportSummary {
  const userdata = NodeFS.realpathSync(options.userdata);
  const output = NodePath.resolve(options.output);
  const parent = NodeFS.realpathSync(NodePath.dirname(output));
  if (parent === userdata || parent.startsWith(`${userdata}${NodePath.sep}`))
    throw new AsrExportError({
      stage: "destination validation",
      cause: new Error("Output must be outside the source userdata directory."),
    });
  let database: NodeSqlite.DatabaseSync | undefined;
  let created = false;
  let stage = "opening the read-only snapshot";
  try {
    database = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"), {
      readOnly: true,
    });
    database.exec("PRAGMA query_only = ON; BEGIN");
    const sourceSequence = Number(
      database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS n FROM orchestration_events WHERE aggregate_kind = 'project' OR (aggregate_kind = 'thread' AND application_event_version = 2)",
        )
        .get()?.n,
    );
    const projection = database
      .prepare(
        "SELECT schema_version, last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'",
      )
      .get();
    if (projection?.schema_version !== 2 || projection.last_sequence !== sourceSequence)
      throw new Error("Projection is stale or uses an unsupported schema.");
    const namespace = NodeFS.readFileSync(NodePath.join(userdata, "environment-id"), "utf8").trim();
    if (!namespace) throw new Error("The environment ID is empty.");
    const threads = readThreads(database, options.threadId);
    if (options.threadId !== undefined && threads.length !== 1)
      throw new Error("The requested thread does not exist.");
    const schedules = readSchedules(database);
    const mirrorRefs = new Map<string, SessionKey>();
    for (const row of database
      .prepare(
        "SELECT json_extract(payload_json, '$.childThreadId') AS child, json_extract(payload_json, '$.nativeTaskRef') AS ref FROM orchestration_v2_projection_subagents WHERE json_extract(payload_json, '$.origin') = 'provider_native' AND json_extract(payload_json, '$.driver') = 'claudeAgent'",
      )
      .all()) {
      if (typeof row.child !== "string" || typeof row.ref !== "string") continue;
      const ref: unknown = JSON.parse(row.ref);
      if (
        typeof ref !== "object" ||
        ref === null ||
        !("nativeId" in ref) ||
        typeof ref.nativeId !== "string" ||
        !("strength" in ref) ||
        ref.strength !== "strong"
      )
        continue;
      // Workflow members use app-generated keys, not Claude transcript agent IDs.
      if (ref.nativeId.includes(":agent:")) continue;
      const key = nativeSession({
        driver: "claudeAgent",
        nativeId: ref.nativeId,
        strength: "strong",
      });
      if (key) mirrorRefs.set(row.child, key);
    }
    stage = "creating the private output directory";
    NodeFS.mkdirSync(output, { mode: 0o700 });
    created = true;
    NodeFS.mkdirSync(NodePath.join(output, "sessions"), { mode: 0o700 });
    const producerInstance = NodeCrypto.randomUUID();
    const observedAt = new Date().toISOString();
    const entries: Array<Record<string, unknown>> = [];
    const references = new Map<string, SessionKey>();
    const included = new Set<string>();
    let totalBytes = 0;
    let totalRecords = 0;
    stage = "reading and mapping threads";
    for (const thread of threads) {
      const source = readThreadSource(database, thread);
      const key: SessionKey = { agent: "t3-code", namespace, sessionId: thread.id };
      const ref = sessionRef(key);
      included.add(ref);
      const file = `sessions/${NodeCrypto.createHash("sha256").update(ref).digest("hex")}.jsonl`;
      const fd = NodeFS.openSync(NodePath.join(output, file), "wx", 0o600);
      const digest = NodeCrypto.createHash("sha256");
      let pending = "";
      let bytes = 0;
      const flush = () => {
        if (!pending) return;
        const buffer = Buffer.from(pending, "utf8");
        writeAll(fd, buffer);
        digest.update(buffer);
        bytes += buffer.byteLength;
        pending = "";
      };
      try {
        const mapper = createThreadMapper({
          source,
          namespace,
          producerVersion: packageJson.version,
          producerInstance,
          observedAt,
          schedules,
          ...(thread.creationSource === "provider" && mirrorRefs.has(thread.id)
            ? { mirror: mirrorRefs.get(thread.id)! }
            : {}),
          write: (record) => {
            pending += `${JSON.stringify(record)}\n`;
            if (pending.length >= 256 * 1024) flush();
          },
        });
        for (const event of readEvents(database, thread.id)) mapper.event(event);
        for (const item of source.items) mapper.item(item);
        const result = mapper.finish();
        for (const reference of result.references) references.set(sessionRef(reference), reference);
        flush();
        NodeFS.fsyncSync(fd);
        totalBytes += bytes;
        totalRecords += result.recordCount;
        entries.push({
          ...key,
          status: "present",
          path: file,
          digest: { alg: "sha256", value: digest.digest("hex") },
          recordCount: result.recordCount,
        });
      } finally {
        NodeFS.closeSync(fd);
      }
    }
    database.exec("ROLLBACK");
    database.close();
    database = undefined;
    let missing = 0;
    for (const [ref, key] of references)
      if (!included.has(ref)) {
        entries.push({ ...key, status: "missing", reason: "not_exported" });
        missing++;
      }
    stage = "publishing the manifest";
    const manifest = `${JSON.stringify(
      {
        formatVersion: "0.1",
        createdAt: new Date().toISOString(),
        producer: { name: "t3-code", version: packageJson.version },
        purpose: "archive",
        sessions: entries,
        _meta: {
          "codes.t3/export": {
            sourceSequence,
            snapshot: true,
            attachments: "not_exported",
            backingSessions: "referenced",
          },
        },
      },
      null,
      2,
    )}\n`;
    NodeFS.writeFileSync(NodePath.join(output, "bundle.json"), manifest, {
      flag: "wx",
      mode: 0o600,
    });
    totalBytes += Buffer.byteLength(manifest);
    return {
      threads: threads.length,
      records: totalRecords,
      bytes: totalBytes,
      referencedSessions: missing,
      sourceSequence,
    };
  } catch (cause) {
    if (created) NodeFS.rmSync(output, { recursive: true, force: true });
    if (isAsrExportError(cause)) throw cause;
    throw new AsrExportError({ stage, cause });
  } finally {
    database?.close();
  }
}

export const layer = Layer.sync(AsrExport, () =>
  AsrExport.of({
    exportBundle: Effect.fn("AsrExport.exportBundle")((options: ExportOptions) =>
      Effect.try({
        try: () => exportSnapshot(options),
        catch: (cause) =>
          isAsrExportError(cause)
            ? cause
            : new AsrExportError({ stage: "source validation", cause }),
      }),
    ),
  }),
);

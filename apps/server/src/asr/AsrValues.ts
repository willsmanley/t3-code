// @effect-diagnostics nodeBuiltinImport:off -- Offline serialization writes content-addressed JSON blobs synchronously.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const raw = JSON as typeof JSON & {
  rawJSON: (source: string) => unknown;
  isRawJSON: (value: unknown) => boolean;
};
export function unsafeNumber(value: unknown): boolean {
  if (raw.isRawJSON(value)) return true;
  if (typeof value === "number")
    return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
  return value !== null && typeof value === "object" && Object.values(value).some(unsafeNumber);
}
export function parseSource(json: string): unknown {
  return JSON.parse(json, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && unsafeNumber(value)) {
      if (!context?.source) throw new Error("Missing exact native number token.");
      return raw.rawJSON(context.source);
    }
    return value;
  });
}

// Reserved destinations from ASR validator-v0.1.2; native payload members stay open.
const destinations = new Set([
  "attachmentAnswers",
  "attemptStatus",
  "backgroundTasks",
  "contextTransfer",
  "createdBy",
  "creationSource",
  "delegatedCompletion",
  "dispatch",
  "fileStats",
  "goalChecks",
  "guest",
  "handoff",
  "historyOrigin",
  "inbox",
  "initialAnswers",
  "limitRecovery",
  "nativeTaskRef",
  "nativeThreadRef",
  "nativeTurnRef",
  "notification",
  "prLink",
  "prWatch",
  "previews",
  "promptCache",
  "providerUsage",
  "required",
  "responseCapability",
  "run",
  "runStatus",
  "scope",
  "secretRequest",
  "subagent",
  "usageStatus",
  "webhookDelivery",
  "workflowScript",
  "remainingFields",
  "jsonText",
  "unassigned",
]);
type Fields = Record<string, unknown>;
export function nativeMeta(value: Fields): Fields {
  const result: Fields = {};
  const remaining: Fields = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    if (destinations.has(key)) result[`codes.t3/${key}`] = entry;
    else remaining[key] = entry;
  }
  if (Object.keys(remaining).length) result["codes.t3/remainingFields"] = remaining;
  return result;
}

export function serializeRecord(record: Fields, output: string): string {
  const jsonText: Fields = {};
  const pointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
  const blob = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const directory = NodePath.join(output, "blobs", "sha256");
    NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(directory, hash), bytes, { mode: 0o600 });
    return { blob: `sha256:${hash}`, size: bytes.length, mimeType: "application/json" };
  };
  const result = { ...record };
  const metadata = { ...(result._meta as Fields | undefined) };
  for (const [key, value] of Object.entries(metadata)) {
    // The tagged registry types these native scalar/array values as objects; BlobRefs retain their actual type.
    if (
      ["codes.t3/createdBy", "codes.t3/creationSource", "codes.t3/workflowScript"].includes(key) &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      metadata[key] = blob(value);
    } else if (unsafeNumber(value)) {
      jsonText[`/_meta/${pointer(key)}`] = JSON.stringify(value);
      delete metadata[key];
    }
  }
  delete result._meta;
  for (const [key, value] of Object.entries(result)) {
    if (!unsafeNumber(value)) continue;
    if (["seq", "id", "type", "sessionId"].includes(key))
      throw new Error(`Unsafe required ASR field: ${key}`);
    delete result[key];
    if (key === "input") result.inputText = JSON.stringify(value);
    else if (["raw", "content", "displayContent", "summary"].includes(key)) {
      result.capture = {
        ...(result.capture as Fields | undefined),
        [key]: { state: "external", blob: blob(value) },
      };
      if (key === "content" && result.type === "message") result.content = [];
    } else jsonText[`/${pointer(key)}`] = JSON.stringify(value);
  }
  if (Object.keys(jsonText).length) metadata["codes.t3/jsonText"] = jsonText;
  if (Object.keys(metadata).length) result._meta = metadata;
  return JSON.stringify(result);
}

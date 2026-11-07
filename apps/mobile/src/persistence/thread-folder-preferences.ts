// Fork (F20): the phone's per-device folder state. Membership is the thread tag `folder:<name>`;
// these only hold the order, empty folders, collapse state and folders picked for unsent drafts.
import * as Schema from "effect/Schema";

/** A folder picked for a draft, keyed by the draft route's request id. */
const PendingThreadFolder = Schema.Struct({
  folder: Schema.String,
  requestedAt: Schema.Number,
  /** Set once the draft is sent: the thread it becomes. */
  thread: Schema.optional(Schema.Struct({ environmentId: Schema.String, threadId: Schema.String })),
});
export type PendingThreadFolder = typeof PendingThreadFolder.Type;

const isPendingThreadFolders = Schema.is(Schema.Record(Schema.String, PendingThreadFolder));
const isStrings = Schema.is(Schema.Array(Schema.String));

export interface ThreadFolderPreferences {
  /** This device's folder order, empty folders included. */
  readonly threadFolders?: readonly string[];
  readonly collapsedThreadFolders?: readonly string[];
  readonly unfiledThreadsCollapsed?: boolean;
  readonly pendingThreadFolders?: Readonly<Record<string, PendingThreadFolder>>;
}

export function sanitizeThreadFolderPreferences(
  parsed: ThreadFolderPreferences,
): ThreadFolderPreferences {
  return {
    ...(isStrings(parsed.threadFolders) ? { threadFolders: parsed.threadFolders } : {}),
    ...(isStrings(parsed.collapsedThreadFolders)
      ? { collapsedThreadFolders: parsed.collapsedThreadFolders }
      : {}),
    ...(typeof parsed.unfiledThreadsCollapsed === "boolean"
      ? { unfiledThreadsCollapsed: parsed.unfiledThreadsCollapsed }
      : {}),
    ...(isPendingThreadFolders(parsed.pendingThreadFolders)
      ? { pendingThreadFolders: parsed.pendingThreadFolders }
      : {}),
  };
}

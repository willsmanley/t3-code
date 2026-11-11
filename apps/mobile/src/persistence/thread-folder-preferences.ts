// Fork (F20): the phone's per-device folder state. Membership is the thread tag `folder:<name>`
// and servers keep the folder list; this holds folders picked for unsent drafts, and the old
// per-device list until it has been handed to the servers.
import * as Schema from "effect/Schema";

/** A folder picked for a draft, keyed by the draft route's request id. */
const PendingThreadFolder = Schema.Struct({
  /** null: started in Unfiled, so the server's default folder doesn't apply. */
  folder: Schema.NullOr(Schema.String),
  requestedAt: Schema.Number,
  /** Set once the draft is sent: the thread it becomes. */
  thread: Schema.optional(Schema.Struct({ environmentId: Schema.String, threadId: Schema.String })),
});
export type PendingThreadFolder = typeof PendingThreadFolder.Type;

const isPendingThreadFolders = Schema.is(Schema.Record(Schema.String, PendingThreadFolder));
const isStrings = Schema.is(Schema.Array(Schema.String));

export interface ThreadFolderPreferences {
  /** The folder order from before servers kept folders; cleared once handed to them. */
  readonly threadFolders?: readonly string[] | undefined;
  readonly collapsedThreadFolders?: readonly string[] | undefined;
  readonly unfiledThreadsCollapsed?: boolean | undefined;
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

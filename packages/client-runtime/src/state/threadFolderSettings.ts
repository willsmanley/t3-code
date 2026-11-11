// Fork (F20): each server's folder settings, merged into the one folder view the clients show,
// with writes sent to every connected server that keeps folders.
import {
  applyThreadFolderUpdate,
  type EnvironmentId,
  type ServerConfig,
  type ThreadFolderSettings,
  type ThreadFolderUpdateInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  EMPTY_SESSION_FOLDER_STATE,
  folderOfTags,
  resolveThreadFolderView,
  type SessionFolderState,
  type ThreadFolderView,
  threadFolderViewsEqual,
} from "../threadFolders.ts";
import { arrayElementsEqual } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "./runtime.ts";

interface PendingSettings {
  /** What the server last sent when this change was made; a newer push replaces the guess. */
  readonly basis: ThreadFolderSettings | undefined;
  readonly settings: ThreadFolderSettings;
}

export interface ThreadFolderUpdateOutcome {
  /** The first failure, if any server refused or could not be reached. */
  readonly failure: unknown;
  /** Threads a rename or delete could not retag, summed over servers. */
  readonly unmovedThreads: number;
  /** False when no connected server keeps folders and only this session's list changed. */
  readonly serverBacked: boolean;
}

function folderNamesOf(threads: ReadonlyArray<EnvironmentThreadShell>): string[] {
  const names = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const folder = folderOfTags(thread.source.tags);
    if (folder !== null) names.add(folder);
  }
  return [...names].sort();
}

export function createThreadFolderSettingsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  input: {
    readonly serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
    readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  },
) {
  const scheduler = createAtomCommandScheduler();
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:thread-folders:live",
    tag: WS_METHODS.threadFoldersSubscribe,
  });
  const update = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:thread-folders:update",
    tag: WS_METHODS.threadFoldersUpdate,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId }) => environmentId,
    },
  });

  let previousSupported: readonly EnvironmentId[] = [];
  /** Connected servers that keep folders. */
  const supportedEnvironmentIdsAtom = Atom.make((get) => {
    const next: EnvironmentId[] = [];
    for (const [environmentId, config] of get(input.serverConfigsAtom)) {
      if (config.threadFolders === true) next.push(environmentId);
    }
    next.sort();
    if (arrayElementsEqual(previousSupported, next)) return previousSupported;
    previousSupported = next;
    return next;
  }).pipe(Atom.withLabel("thread-folders:supported-environments"));

  const pendingAtom = Atom.make<ReadonlyMap<EnvironmentId, PendingSettings>>(new Map()).pipe(
    Atom.keepAlive,
    Atom.withLabel("thread-folders:pending"),
  );
  const sessionAtom = Atom.make<SessionFolderState>(EMPTY_SESSION_FOLDER_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel("thread-folders:session"),
  );

  const liveSettingsOf = (
    get: Atom.AtomContext,
    environmentId: EnvironmentId,
  ): ThreadFolderSettings | undefined =>
    Option.getOrUndefined(AsyncResult.value(get(live({ environmentId, input: {} }))));

  /** Each server's settings as last sent, or as just changed here until the server answers. */
  const settingsByEnvironmentAtom = Atom.make((get) => {
    const pending = get(pendingAtom);
    const next = new Map<EnvironmentId, ThreadFolderSettings>();
    for (const environmentId of get(supportedEnvironmentIdsAtom)) {
      const sent = liveSettingsOf(get, environmentId);
      const guess = pending.get(environmentId);
      const settings = guess !== undefined && guess.basis === sent ? guess.settings : sent;
      if (settings !== undefined) next.set(environmentId, settings);
    }
    return next;
  }).pipe(Atom.withLabel("thread-folders:settings-by-environment"));

  let previousThreadFolderNames: readonly string[] = [];
  const threadFolderNamesAtom = Atom.make((get) => {
    const next = folderNamesOf(get(input.threadShellsAtom));
    if (arrayElementsEqual(previousThreadFolderNames, next)) return previousThreadFolderNames;
    previousThreadFolderNames = next;
    return next;
  }).pipe(Atom.withLabel("thread-folders:names-from-threads"));

  let previousView: ThreadFolderView | null = null;
  const viewAtom = Atom.make((get): ThreadFolderView => {
    const next = resolveThreadFolderView({
      servers: [...get(settingsByEnvironmentAtom).values()],
      fromThreads: get(threadFolderNamesAtom),
      session: get(sessionAtom),
    });
    if (previousView !== null && threadFolderViewsEqual(previousView, next)) return previousView;
    previousView = next;
    return next;
  }).pipe(Atom.withLabel("thread-folders:view"));

  /** True once every server that keeps folders has sent them, so the view won't jump. */
  const loadedAtom = Atom.make((get) => {
    const supported = get(supportedEnvironmentIdsAtom);
    return supported.every((environmentId) => liveSettingsOf(get, environmentId) !== undefined);
  }).pipe(Atom.withLabel("thread-folders:loaded"));

  /** Sends `change` to every server that keeps folders; with none, changes this session's list. */
  const apply = async (
    registry: AtomRegistry.AtomRegistry,
    change: ThreadFolderUpdateInput,
  ): Promise<ThreadFolderUpdateOutcome> => {
    const environmentIds = registry.get(supportedEnvironmentIdsAtom);
    if (environmentIds.length === 0) {
      registry.set(sessionAtom, applySessionFolderUpdate(registry.get(sessionAtom), change));
      return { failure: null, unmovedThreads: 0, serverBacked: false };
    }
    const now = DateTime.formatIso(DateTime.nowUnsafe());
    const current = registry.get(settingsByEnvironmentAtom);
    const pending = new Map(registry.get(pendingAtom));
    for (const environmentId of environmentIds) {
      const settings = current.get(environmentId);
      if (settings === undefined) continue;
      pending.set(environmentId, {
        basis: Option.getOrUndefined(
          AsyncResult.value(registry.get(live({ environmentId, input: {} }))),
        ),
        settings: applyThreadFolderUpdate(settings, change, now),
      });
    }
    registry.set(pendingAtom, pending);
    const results = await Promise.all(
      environmentIds.map(async (environmentId) => ({
        environmentId,
        result: await runAtomCommand(
          registry,
          update,
          { environmentId, input: change },
          { reportFailure: false },
        ),
      })),
    );
    let failure: unknown = null;
    let unmovedThreads = 0;
    const failed = new Set<EnvironmentId>();
    for (const { environmentId, result } of results) {
      if (result._tag === "Success") {
        unmovedThreads += result.value.unmovedThreads;
        continue;
      }
      failed.add(environmentId);
      if (failure === null && !isAtomCommandInterrupted(result)) {
        failure = squashAtomCommandFailure(result);
      }
    }
    if (failed.size > 0) {
      const next = new Map(registry.get(pendingAtom));
      for (const environmentId of failed) next.delete(environmentId);
      registry.set(pendingAtom, next);
    }
    return { failure, unmovedThreads, serverBacked: true };
  };

  return {
    live,
    update,
    supportedEnvironmentIdsAtom,
    settingsByEnvironmentAtom,
    threadFolderNamesAtom,
    viewAtom,
    loadedAtom,
    apply,
  } as const;
}

/** The session list's version of a server update; threads are retagged by the caller. */
function applySessionFolderUpdate(
  state: SessionFolderState,
  change: ThreadFolderUpdateInput,
): SessionFolderState {
  const next = applyThreadFolderUpdate(
    {
      folders: state.folders.map((name) => ({ name, collapsed: state.collapsed.includes(name) })),
      defaultFolder: null,
      unfiledCollapsed: state.unfiledCollapsed,
      updatedAt: null,
    },
    // No server means no default folder; leave the list alone.
    change._tag === "setDefault" ? { _tag: "create", names: [] } : change,
    "",
  );
  return {
    folders: next.folders.map((entry) => entry.name),
    collapsed: next.folders.flatMap((entry) => (entry.collapsed ? [entry.name] : [])),
    unfiledCollapsed: next.unfiledCollapsed,
  };
}

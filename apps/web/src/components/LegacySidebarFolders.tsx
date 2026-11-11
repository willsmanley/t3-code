// Fork (F20): folder dialogs, menus and actions for the legacy sidebar.
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import {
  deviceFolderMigrationStep,
  folderNameProblem,
  planFolderPerProject,
} from "@t3tools/client-runtime/thread-folders";
import { AuthOrchestrationOperateScope, type ContextMenuItem } from "@t3tools/contracts";
import { CheckIcon, FolderIcon, FolderInputIcon, FolderPlusIcon, InboxIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { forceLegacySidebar, isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells, useThreadShells } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import {
  addFolders,
  deleteFolder,
  fileThreads,
  folderOfThread,
  forgetLegacyDeviceFolders,
  hasPendingDraftFolders,
  moveThreadsToFolder,
  readFolderOrder,
  readLegacyDeviceFolders,
  renameFolder,
  setDefaultFolder,
  takeArrivedDraftFolders,
  threadFolderSettings,
  threadsInFolder,
  useDraftFolderStore,
  useFolderOrder,
  useFolderView,
} from "./legacySidebarFolders.store";
import { isSidebarHiddenThread } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface FolderNameRequest {
  readonly kind: "name";
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly confirmLabel: string;
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
}

interface FolderPickRequest {
  readonly kind: "pick";
  readonly id: number;
  readonly title: string;
  /** The threads' shared folder: a name, null for Unfiled, undefined when they differ. */
  readonly current: string | null | undefined;
  readonly resolve: (choice: { readonly folder: string | null } | null) => void;
}

type FolderDialogRequest = FolderNameRequest | FolderPickRequest;

const useFolderDialog = create<{ request: FolderDialogRequest | null }>(() => ({ request: null }));
let nextRequestId = 0;

function cancelFolderDialog() {
  const request = useFolderDialog.getState().request;
  useFolderDialog.setState({ request: null });
  request?.resolve(null);
}

function requestFolderName(
  input: Omit<FolderNameRequest, "kind" | "id" | "resolve">,
): Promise<string | null> {
  cancelFolderDialog();
  return new Promise((resolve) => {
    nextRequestId += 1;
    useFolderDialog.setState({ request: { ...input, kind: "name", id: nextRequestId, resolve } });
  });
}

function requestFolderPick(
  input: Omit<FolderPickRequest, "kind" | "id" | "resolve">,
): Promise<{ readonly folder: string | null } | null> {
  cancelFolderDialog();
  return new Promise((resolve) => {
    nextRequestId += 1;
    useFolderDialog.setState({ request: { ...input, kind: "pick", id: nextRequestId, resolve } });
  });
}

function finishFolderName(name: string | null) {
  const request = useFolderDialog.getState().request;
  if (request?.kind !== "name") return;
  useFolderDialog.setState({ request: null });
  request.resolve(name);
}

function finishFolderPick(choice: { readonly folder: string | null } | null) {
  const request = useFolderDialog.getState().request;
  if (request?.kind !== "pick") return;
  useFolderDialog.setState({ request: null });
  request.resolve(choice);
}

function sharedFolder(threads: readonly EnvironmentThreadShell[]): string | null | undefined {
  const folders = new Set(threads.map(folderOfThread));
  return folders.size === 1 ? [...folders][0] : undefined;
}

function threadCountLabel(count: number) {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

/** Asks for a name, makes the folder, and files `threads` in it. */
async function promptNewFolder(threads: readonly EnvironmentThreadShell[] = []) {
  const name = await requestFolderName({
    title: "New folder",
    description:
      threads.length > 0 ? `${threadCountLabel(threads.length)} will move into it.` : null,
    confirmLabel: "Create",
    initialName: "",
  });
  if (name === null) return;
  addFolders([name]);
  if (threads.length > 0) await moveThreadsToFolder(threads, name);
}

/** Lets the user pick a folder, or type a new one, for `threads`. */
async function promptMoveThreadsToFolder(threads: readonly EnvironmentThreadShell[]) {
  if (threads.length === 0) return;
  const choice = await requestFolderPick({
    title:
      threads.length === 1 ? "Move thread to folder" : `Move ${threads.length} threads to folder`,
    current: sharedFolder(threads),
  });
  if (choice === null) return;
  await moveThreadsToFolder(threads, choice.folder);
}

async function promptRenameFolder(folder: string) {
  const name = await requestFolderName({
    title: "Rename folder",
    description: null,
    confirmLabel: "Rename",
    initialName: folder,
  });
  if (name === null || name === folder) return;
  if (readFolderOrder().includes(name)) {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      `A folder named "${name}" already exists. Move the threads in "${folder}" into it?`,
    );
    if (!confirmed) return;
  }
  await renameFolder(folder, name);
}

async function confirmDeleteFolder(folder: string) {
  const count = threadsInFolder(folder).length;
  if (count > 0) {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        `Delete folder "${folder}"?`,
        `Its ${threadCountLabel(count)} move to Unfiled. No thread is deleted.`,
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
  }
  await deleteFolder(folder);
}

/** The one-time start: a folder per project, with each listed thread filed under its project. */
export async function makeFolderPerProject(projects: readonly SidebarProjectSnapshot[]) {
  const threads = readThreadShells().filter(
    (thread) =>
      thread.archivedAt === null &&
      !isSidebarHiddenThread(thread) &&
      folderOfThread(thread) === null,
  );
  const plan = planFolderPerProject({
    projects: projects.map((project) => ({
      displayName: project.displayName,
      archived: project.archived,
      projectKeys: project.memberProjectRefs.map(scopedProjectKey),
    })),
    threads,
    projectKeyOf: (thread) =>
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
  });
  if (plan.folders.length === 0) return;
  const confirmed = await readLocalApi()?.dialogs.confirm(
    [
      `Make ${plan.folders.length} folder${plan.folders.length === 1 ? "" : "s"}, one for each project, and file ${threadCountLabel(plan.assignments.length)} in them?`,
      "Threads keep running in their own projects.",
    ].join("\n"),
  );
  if (!confirmed) return;
  addFolders(plan.folders);
  await fileThreads(plan.assignments);
}

/** A folder header's menu: rename, where new threads go, delete. `handle` runs the clicked item. */
export function legacyFolderHeaderMenu(folder: string) {
  const view = appAtomRegistry.get(threadFolderSettings.viewAtom);
  const isDefault = view.defaultFolder === folder;
  const items: ContextMenuItem<string>[] = [
    { id: "rename", label: "Rename" },
    ...(view.serverBacked
      ? [
          {
            id: "default",
            label: isDefault ? "Stop sending new threads here" : "New threads go here",
          },
        ]
      : []),
    { id: "delete", label: "Delete folder", destructive: true, icon: "trash" },
  ];
  const handle = async (clicked: string | null) => {
    if (clicked === "rename") await promptRenameFolder(folder);
    if (clicked === "default") setDefaultFolder(isDefault ? null : folder);
    if (clicked === "delete") await confirmDeleteFolder(folder);
  };
  return { items, handle };
}

/** A quiet mark beside the folder new threads land in. */
export function DefaultFolderMark({ folder }: { folder: string }) {
  const isDefault = useFolderView().defaultFolder === folder;
  if (!isDefault) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label="New threads go here"
            className="shrink-0 text-3xs text-sidebar-muted-foreground/70"
          />
        }
      >
        default
      </TooltipTrigger>
      <TooltipPopup side="top">New threads go here</TooltipPopup>
    </Tooltip>
  );
}

/** "Move to folder" and "Remove from folder" for a thread menu; `handle` says if it took the click. */
export function legacyThreadFolderMenu(threads: readonly EnvironmentThreadShell[]) {
  const folders = readFolderOrder();
  const current = sharedFolder(threads);
  const canOperate = threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
  const items: ContextMenuItem<string>[] = [
    {
      id: "folder-move",
      label: "Move to folder",
      disabled: !canOperate,
      children: [
        ...folders.map((name, index) => ({
          id: `folder-move:${index}`,
          label: name,
          checked: current === name,
        })),
        { id: "folder-new", label: "New folder…", separatorBefore: folders.length > 0 },
      ],
    },
    ...(threads.some((thread) => folderOfThread(thread) !== null)
      ? [{ id: "folder-remove", label: "Remove from folder", disabled: !canOperate }]
      : []),
  ];
  const handle = (clicked: string | null): boolean => {
    if (clicked === "folder-new") {
      void promptNewFolder(threads);
      return true;
    }
    if (clicked === "folder-remove") {
      void moveThreadsToFolder(threads, null);
      return true;
    }
    if (!clicked?.startsWith("folder-move:")) return false;
    const folder = folders[Number(clicked.slice("folder-move:".length))];
    if (folder !== undefined) void moveThreadsToFolder(threads, folder);
    return true;
  };
  return { items, handle };
}

/** Command palette actions; only the legacy sidebar shows folders. */
export function legacyFolderPaletteItems(
  activeThread: EnvironmentThreadShell | null,
): CommandPaletteActionItem[] {
  if (!isElectron && !forceLegacySidebar) return [];
  const newFolder: CommandPaletteActionItem = {
    kind: "action",
    value: "action:legacy-folder-new",
    searchTerms: ["new folder", "create folder", "folder"],
    title: "New folder",
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    run: () => promptNewFolder(),
  };
  if (activeThread === null) return [newFolder];
  return [
    {
      kind: "action",
      value: "action:legacy-folder-move",
      searchTerms: ["move to folder", "folder", "file", "organize", "unfiled"],
      title: "Move to folder…",
      description: folderOfThread(activeThread) ?? "Unfiled",
      icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
      run: () => promptMoveThreadsToFolder([activeThread]),
    },
    newFolder,
  ];
}

export function NewFolderButton() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="New folder"
            data-testid="sidebar-new-folder"
            onClick={() => void promptNewFolder()}
          />
        }
      >
        <FolderPlusIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="right">New folder</TooltipPopup>
    </Tooltip>
  );
}

/** Folder dialogs and filing of sent drafts; mounted beside the sidebar, so a closed one works. */
export function LegacySidebarFoldersHost() {
  const request = useFolderDialog((state) => state.request);
  const hasPending = useDraftFolderStore(hasPendingDraftFolders);
  const [hasDeviceFolders, setHasDeviceFolders] = useState(
    () => readLegacyDeviceFolders() !== null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Resolves an open folder request with null when the host unmounts.
  useEffect(() => () => cancelFolderDialog(), []);
  return (
    <>
      {hasDeviceFolders ? <DeviceFolderMigration onDone={setHasDeviceFolders} /> : null}
      {hasPending ? <DraftFolderFiler /> : null}
      {request?.kind === "name" ? <FolderNameDialog key={request.id} request={request} /> : null}
      {request?.kind === "pick" ? <FolderPickDialog key={request.id} request={request} /> : null}
    </>
  );
}

/** Hands this device's saved folder list to the servers once, then forgets it. */
function DeviceFolderMigration({ onDone }: { onDone: (pending: false) => void }) {
  const environmentIds = useAtomValue(threadFolderSettings.supportedEnvironmentIdsAtom);
  const settings = useAtomValue(threadFolderSettings.settingsByEnvironmentAtom);
  const running = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Moves the device's localStorage folder list to the servers once they report their folder settings.
  useEffect(() => {
    const device = readLegacyDeviceFolders();
    if (device === null) {
      onDone(false);
      return;
    }
    if (running.current) return;
    const step = deviceFolderMigrationStep({ device, environmentIds, settings });
    if (step.type === "wait") return;
    if (step.type === "forget") {
      forgetLegacyDeviceFolders();
      onDone(false);
      return;
    }
    running.current = true;
    void threadFolderSettings.apply(appAtomRegistry, step.update).then((outcome) => {
      running.current = false;
      if (outcome.failure !== null) return;
      forgetLegacyDeviceFolders();
      onDone(false);
    });
  }, [environmentIds, settings, onDone]);
  return null;
}

function DraftFolderFiler() {
  const threads = useThreadShells();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tags a sent draft's thread on its server once that thread shows up in the thread list.
  useEffect(() => {
    const byKey = new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread,
      ]),
    );
    const drafts = useComposerDraftStore.getState();
    const arrived = takeArrivedDraftFolders(
      (draftId, savedThreadKey) => {
        const session = drafts.getDraftSession(DraftId.make(draftId));
        const redirect = drafts.promotedDraftRedirects[draftId];
        return [
          savedThreadKey,
          ...(session
            ? [
                scopedThreadKey(
                  session.promotedTo ?? scopeThreadRef(session.environmentId, session.threadId),
                ),
              ]
            : []),
          ...(redirect ? [scopedThreadKey(redirect)] : []),
        ];
      },
      (threadKey) => byKey.has(threadKey),
    );
    // Servers that take a launch folder already filed it; older ones need the tags set here.
    for (const { threadKey, folder } of arrived) {
      const thread = byKey.get(threadKey);
      if (thread && folderOfThread(thread) !== folder) void moveThreadsToFolder([thread], folder);
    }
  }, [threads]);
  return null;
}

function FolderNameDialog({ request }: { request: FolderNameRequest }) {
  const [name, setName] = useState(request.initialName);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    const nextProblem = folderNameProblem(name);
    if (nextProblem !== null) {
      setProblem(nextProblem);
      return;
    }
    finishFolderName(name.trim());
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finishFolderName(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
            {request.description ? (
              <DialogDescription>{request.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Folder name"
              placeholder="Folder name"
              value={name}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
            />
            {problem ? <p className="mt-2 text-destructive text-xs">{problem}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finishFolderName(null)}>
              Cancel
            </Button>
            <Button type="submit">{request.confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function FolderPickDialog({ request }: { request: FolderPickRequest }) {
  const folders = useFolderOrder();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const search = typed.toLocaleLowerCase();
  // Enter takes the first row, so an exact match leads.
  const matches = folders
    .filter((name) => name.toLocaleLowerCase().includes(search))
    .toSorted((left, right) => Number(right === typed) - Number(left === typed));
  const isNew = typed.length > 0 && !folders.includes(typed);
  const problem = isNew ? folderNameProblem(typed) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finishFolderPick(null);
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">{request.title}</DialogTitle>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label={request.title}>
          <CommandInput placeholder="Find a folder, or type a new name…" />
          <CommandList className="max-h-80 overflow-y-auto">
            {matches.map((name) => (
              <CommandItem
                key={name}
                value={`folder:${name}`}
                onClick={() => finishFolderPick({ folder: name })}
              >
                <FolderIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {request.current === name ? <CheckIcon aria-hidden className="size-3.5" /> : null}
              </CommandItem>
            ))}
            {isNew && problem === null ? (
              <CommandItem value="create" onClick={() => finishFolderPick({ folder: typed })}>
                <FolderPlusIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
                <span className="min-w-0 flex-1 truncate">New folder “{typed}”</span>
              </CommandItem>
            ) : null}
            {"unfiled".includes(search) ? (
              <CommandItem value="unfiled" onClick={() => finishFolderPick({ folder: null })}>
                <InboxIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
                <span className="min-w-0 flex-1 truncate">Unfiled</span>
                {request.current === null ? <CheckIcon aria-hidden className="size-3.5" /> : null}
              </CommandItem>
            ) : null}
            {problem ? <div className="px-3 py-2 text-destructive text-xs">{problem}</div> : null}
          </CommandList>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}

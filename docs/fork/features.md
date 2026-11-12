# Fork features

What this fork (willsmanley/t3-code) adds on top of upstream (pingdotgg/t3code), where each
feature touches upstream files, how to check it after a merge, and which overlaps to shrink. The
nightly sync ([upstream-sync.md](upstream-sync.md)) reads this file and keeps it current. When you
add a fork feature, add it here.

Measurements in the hotspot table are from fork main `ea7c8bf901` and upstream `148d2fdc0e`
(October 26, 2026). Commands run from the repo root. `vp test run <files>` runs tests; add
`-t "<name>"` to pick tests by name.

## Merge hazards

- **Two ways a merge can break the build without a text conflict.** The Git-off switch (F5) makes
  three upstream services need `ServerSettingsService`. Direct push (F6) makes `ws.ts` and
  `AgentAwarenessRelay` need `DirectPush`, and folders (F20) make `ws.ts` need
  `ThreadFolderSettingsService`. So any new upstream test or harness that builds those layers will
  fail to typecheck until it gets `ServerSettings.layerTest()` or a `DirectPush` or
  `ThreadFolderSettingsService` mock.
- **The agent context budget.** `AgentContextBudget.test.ts` compares the measured size of the
  MCP tool list and agent instructions with `apps/server/src/provider/agentContextBudget.json`
  exactly. The fork's scheduling fields make the tool list larger, so after each merge set the
  file to the values the test reports, and keep fork tool text short.
- **Library upgrades reach fork-owned code.** When upstream moved to Effect 4.1 (November 3,
  2026), `effect/Crypto` went away. Fork code now uses `effect/crypto/Digest` and
  `effect/crypto/SecureRandom`, and fork tests provide `NodeCrypto.layer` next to
  `NodeServices.layer`. A `catchTags` handler for an error that can no longer happen left
  `undefined` in a layer's requirements and broke every CLI test's typecheck far from the cause.
- **Upstream's error and typecheck rules.** Upstream `298cb24140` made errors `Schema.TaggedError`
  and turned on the Effect rules `extendsNativeError`, `instanceOfSchema`, `globalDateInEffect` and
  `effectFnOpportunity` as errors. Fork errors are `Schema.TaggedError` built with an object
  (`new VoiceTranscriptionError({ code, message })`, `new ServerDictationRejected({ reason, message })`)
  and checked with `Schema.is(X)`, not `instanceof`. Inside Effect code read time through `Clock`,
  and in `it.effect` tests move time with `TestClock.adjust`. Since `95e53a54db` each package
  typechecks with `effect-tsgo tsrs --noEmit` (fork packages too, such as `provider-prime`); run
  `vp run -r typecheck`, because `check:changed` stops reporting at the first failing package.
- **The lockfile.** A merged `pnpm-lock.yaml` with no text conflict can still disagree with itself
  (`ERR_PNPM_INCONSISTENT_PATCH_HASH` from `pnpm install --frozen-lockfile`). Take upstream's
  lockfile and run `pnpm install`, as the runbook says for a conflicted one.
- **Renamed upstream symbols.** `webhookDraftErrors` became `scheduleDraftErrors` (web scheduler
  logic). Renames turn upstream
  edits near those names into conflicts. Prefer keeping the upstream name.
- **Dead-code sweeps.** Upstream deletes or un-exports code nothing upstream reaches (for
  example `readEnvironmentSupportsSnooze`, `logRegistrationDebug`, `useWorkspaceListNavigation`
  and the `SettingsActionRow` re-export in October 2026), even when the fork uses it. The
  typecheck finds these. Prefer a small copy in the fork-owned file over restoring upstream's.
- **New upstream rules reach fork-owned files.** Upstream adds lint rules and compile checks
  (React Compiler coverage, which also runs in `check:changed` and rejects `finally` and `throw`
  inside `try` in hooks; effect reasons: every effect needs
  `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`) often. The merge doesn't touch fork-owned files, so
  only the check against `origin/main` catches them. Follow upstream's fix or suppression pattern
  in the matching upstream file.
- **Rewrites drop fork edits quietly.** When upstream rewrites a file the fork edited, a merge can
  keep upstream's version with no conflict. That is how the scheduler's time-zone and one-off hints
  left `packages/provider-core/src/server/orchestrationInstructions.ts`; the MCP tool descriptions
  still cover them. Run each feature's checks below after every merge.
- **Don't rename upstream symbols or delete upstream code you could leave in place.** Both turn
  every nearby upstream edit into a conflict.

## 1. Fork features

### F1. Desktop keeps the project-tree sidebar, with a lighter look (web/desktop)

Commits `d3187229ad`, `29237dd70b`, `9a37a396d9`, `8ca12e915d`, `2015876939`; restored as a
fork-owned file on October 30, 2026, after upstream deleted it (`4e4d4ba395`).

What it does: desktop (Electron), and web preview builds made with `VITE_T3CODE_LEGACY_SIDEBAR=1`,
always use the project-tree ("legacy") sidebar; since F20 it lists folders instead of projects.
The sidebar is also lighter: no project favicons, no remote-environment icons or labels, a small status dot in a fixed
column left of the title, and short timestamps like "5m". Elsewhere upstream's sidebars apply,
including the Labs "boring sidebar".

Fork-owned files: `apps/web/src/components/LegacySidebar.tsx` (upstream's last copy plus the fork's
changes), `apps/web/src/components/LegacySidebar.logic.ts` (+ test; helpers upstream removed from
`Sidebar.logic.ts`, including `archiveSelectedThreadEntries` and `resolveProjectStatusIndicator`;
the project sort went away with F20).

Touch points:

- `apps/web/src/env.ts`: adds `forceLegacySidebar` (reads `VITE_T3CODE_LEGACY_SIDEBAR`).
- `apps/web/vite.config.ts`, `apps/web/src/vite-env.d.ts`: define and type that variable.
- `apps/web/src/components/AppSidebarLayout.tsx`: `isElectron || forceLegacySidebar` picks
  `LegacyThreadSidebar`.
- `apps/web/src/shortcuts/chatRouteCommands.ts`: the `chat.new` shortcut treats desktop as using
  a project sidebar (`... || isElectron || forceLegacySidebar`).
- `apps/web/src/components/RelativeTime.tsx`: adds a `compact` prop that drops the suffix.
- `apps/web/src/components/ThreadStatusIndicators.tsx`: dot size `size-[9px]` → `size-1.5`;
  exports `ThreadStatusLabel` and `PrStatusTooltipContent` again.
- `apps/web/src/state/use-orchestration-command.ts`: exports `ORCHESTRATION_OPERATE_DENIED_MESSAGE`
  again.
- `packages/contracts/src/settings.ts`: keeps the `sidebarThreadPreviewCount` client setting
  ("Show more" threshold) that upstream removed.
- `apps/web/package.json`, `pnpm-lock.yaml`: keeps `@formkit/auto-animate`.
- Inside `LegacySidebar.tsx`: no `ProjectFavicon` or `EnvironmentMachineIcon`, `ThreadStatusLabel
  compact` in a left column, `<RelativeTime compact>`.

When upstream changes an API the file uses, fix the file; don't merge upstream's sidebar into it.

Verify (no tests cover the look):

- `grep -n "isElectron || forceLegacySidebar" apps/web/src/components/AppSidebarLayout.tsx apps/web/src/shortcuts/chatRouteCommands.ts` (one hit each).
- `grep -n "ProjectFavicon\|EnvironmentMachineIcon" apps/web/src/components/LegacySidebar.tsx` (no hits).
- Look at the desktop nightly: folder tree, small dots, compact times.

### F2. Snooze threads from the project sidebar (web/desktop)

Commit `83c5b5df96`.

What it does: the project sidebar's thread menu and multi-select menu can snooze and unsnooze.
Snoozed threads leave their folder (F20) and appear in a "Snoozed" section at the bottom.

Fork-owned files: `apps/web/src/components/LegacySidebar.snooze.tsx`,
`LegacySidebar.snooze.logic.ts`, `LegacySidebar.snooze.logic.test.ts`.

Touch points: inside `LegacySidebar.tsx` (fork-owned, F1): `useWithoutLegacySnoozed()`,
`legacyThreadSnoozeMenu` / `legacyBulkSnoozeMenu`, `<LegacySnoozedSection>` and
`useProvideLegacySnoozeActions(...)`. Depends on upstream `useThreadActions()` returning
`snoozeThread` and `unsnoozeThread`, `resolveSnoozePresets(now, timestampFormat, environmentId)`,
and `filterSidebarV2VisibleThreads(threads, scope, useDelegatedUnderParent())`.

Verify:

- `vp test run apps/web/src/components/LegacySidebar.snooze.logic.test.ts`
- `grep -c "LegacySnoozedSection\|useWithoutLegacySnoozed\|legacyThreadSnoozeMenu\|legacyBulkSnoozeMenu\|useProvideLegacySnoozeActions" apps/web/src/components/LegacySidebar.tsx`
  (11 today; fewer means a hook was dropped).

### F3. "Fork conversation" and "Copy provider session ID" in thread menus (web/desktop)

Part of commit `0f7de6350a`, whose title only mentions the SSH runtime.

What it does: thread menus in the new sidebar, the project sidebar and the chat thread menu get
"Fork conversation", which copies the thread up to its latest stable point into a new thread and
opens it. They also get "Copy provider session ID", which copies the native Codex or Claude
session ID.

Fork-owned files: `apps/web/src/hooks/useThreadConversationActions.ts` (+ test),
`apps/web/src/lib/threadProviderIdentity.ts` (+ test).

Touch points:

- `packages/client-runtime/src/operations/commands.ts`: adds `ForkThreadFromLatestStableInput` and
  `forkThreadFromLatestStable`, which dispatches `thread.fork` with
  `sourcePoint: { type: "latest_stable" }` (+ `commands.test.ts`).
- `packages/client-runtime/src/state/threadCommands.ts`: adds the `forkFromLatestStable` atom
  command. Mobile F9 uses it too.
- `packages/client-runtime/src/state/orchestration.ts`: adds the `threadIdentity` command, which
  reads the bounded thread snapshot and returns the thread and its provider threads.
- `apps/web/src/components/threadActionMenu.logic.ts`: menu IDs `fork-conversation` and
  `copy-provider-session-id`, plus their items (+ test).
- `apps/web/src/hooks/useThreadActionMenu.ts`: two switch cases (+ test).
- `apps/web/src/components/Sidebar.tsx`: hook call and two switch cases.
- `apps/web/src/components/LegacySidebar.tsx` (fork-owned, F1): hook call, two menu items, two
  handlers.

Verify:

- `vp test run apps/web/src/hooks/useThreadConversationActions.test.ts apps/web/src/lib/threadProviderIdentity.test.ts apps/web/src/components/threadActionMenu.logic.test.ts apps/web/src/hooks/useThreadActionMenu.test.ts packages/client-runtime/src/operations/commands.test.ts`
- `grep -ln '"fork-conversation"' apps/web/src/components/Sidebar.tsx apps/web/src/components/LegacySidebar.tsx apps/web/src/hooks/useThreadActionMenu.ts apps/web/src/components/threadActionMenu.logic.ts` (all four files listed).

### F4. Scheduler: time zones, active hours, tasks that end themselves

Commits `7b635bccae`, `c4674d8d70`, `6e4956e624`, `15ef0c5a16`, `26bc3b2dc5`, `229aaaec8d`.

What it does: a scheduled task can (a) run a fixed-time schedule in a chosen IANA time zone,
(b) limit an interval task to active hours, and (c) stop after N runs or at an end time. A task
that ends stays listed but switched off, labeled Ended. All of this works in web settings, mobile
settings and the agent MCP tools (`schedule_task`, which also updates a task given
`scheduledTaskId`). The tool's `bindToCurrentThread` and `freshSession` text tells agents to keep
runs in the thread that set the task up (that thread starts any subagents) and to pick a new
thread or fresh session per run only when the user asks. An agent once switched a refund
follow-up to a new thread per run, and its runs lost the thread's history.

One-off tasks are upstream's since November 1, 2026 (`{ type: "once", runAt }`, upstream
`4ac97be2b6`). The fork's own one-off (`{ type: "once", at }`, switched off after its run and
skipped when missed) was dropped in that merge. Upstream's one-off stays on after it runs, with no
next run, and runs late if the server was down. Stored fork one-offs are rewritten to `runAt` at
startup by `apps/server/src/scheduledTasks/legacyOnceSchedules.ts` (+ test). Older fork one-offs
that already ran stay switched off and show Done or Missed (`scheduledTaskEnding`).

Fork-owned files: `packages/client-runtime/src/scheduledTaskSchedule.ts` (+ test), the draft
helpers shared by web and mobile; `apps/server/src/scheduledTasks/legacyOnceSchedules.ts` (+ test).

Touch points:

- `packages/contracts/src/scheduledTask.ts`: new schema pieces (`timeZone`, `activeHours`,
  `endAfterRuns` / `endAt`), the validators `isValidTimeZone` and `isAbsoluteDateTime` (end
  times), and `ScheduledTaskUpsertFixedTimeSchedule` in the upsert union (+ `scheduledTask.test.ts`).
  The `once` member is upstream's.
- `packages/contracts/src/orchestratorMcp.ts`: schedule description, the `bindToCurrentThread`
  and `freshSession` guidance, and `runCount` on the MCP task summary.
- `apps/server/src/scheduledTasks/Schedule.ts`: `activeHoursDeferral`, `endsToStore`,
  `timerScheduleToStore` (also stores upstream's `runAt` in UTC), `scheduleEnd` (never ends a
  one-off), time-zone-aware next run (+ `Schedule.test.ts`).
- `apps/server/src/scheduledTasks/ScheduledTaskService.ts`: `nextRunState` / `endedMessage`
  replace upstream's `nextRunAt`; upstream's `nextRunAfterRun` became `runOrigin`, and its
  `requireFutureOnce` uses `nextRunTime`. SQL updates switch ended tasks off
  (`enabled = CASE WHEN ... THEN 0`). The run completion uses upstream's transaction with the
  fork's run state. `runDueTasks` calls `endExpiredWebhookTasks`, which also returns the next
  webhook end time so upstream's idle wake-up still switches webhooks off on time; it defers runs
  that fall outside active hours and applies webhook run limits. The layer calls
  `migrateLegacyOnceSchedules` before its crash recovery (+ `ScheduledTaskService.schedule.test.ts`,
  `ScheduledTaskService.webhook.test.ts`).
- `apps/server/src/mcp/OrchestratorMcpService.ts`: `runCount` in the summary.
- `apps/server/src/mcp/toolkits/orchestrator/tools.ts`: the `schedule_task` description's
  time-zone and kept-on-update hints.
- `apps/server/src/provider/agentContextBudget.json`: `mcpToolListJsonBytes` is the fork's
  measured size (see "Merge hazards").
- `apps/web/src/components/settings/ScheduledTasksSettings.tsx`: time zone field, active hours,
  "Stop after N runs / at" fields (hidden for once), `ScheduledStoppedLabel`. The Once toggle is
  upstream's. Upstream's short server zone beside "Run at" (`serverZone`, November 12, 2026)
  shows only while the task's own time zone is blank.
- `apps/web/src/components/settings/scheduledTasksSettings.logic.ts`: draft fields, the fork's
  checks in upstream's `scheduleDraftErrors` (webhook checks in a private `webhookDraftErrors`),
  `endsFromDraft`; end times use upstream's `toDateTimeLocalValue` (+ test). `scheduleLabel`
  (upstream moved it here) adds the run limit and end time, and `cadenceLabel` names a task's own
  zone in full and otherwise upstream's short server zone (`scheduleTimeZoneLabel`).
- `apps/web/src/components/chat/ThreadAutomationsPanel.tsx`: uses `ScheduledStoppedLabel`.
- `apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx`: the same fields on
  mobile (`TimeOfDayRow`, `InstantRows` for the end time, `stoppedLabel`). The once rows and
  `runAtPicker` are upstream's. `TimeOfDayRow`'s `zone` shows upstream's short server zone while
  the task has no zone, and `describeCadence` names a task's own zone in full.
- `apps/mobile/src/features/settings/scheduledTaskDraft.ts`: draft fields; upstream's once branch
  runs first in `scheduleFromDraft`, so stop fields never block a once save (+ test).
- `packages/client-runtime/package.json`: export `./scheduled-task-schedule`.
- `apps/server/scripts/migrate-dev-db.ts`: seeded dev databases also clear
  `scheduled_task_webhook_pending` and `scheduled_task_webhook_replay_keys`.
- `docs/user/project-settings.md`: user docs.

Verify:

- `vp test run packages/contracts/src/scheduledTask.test.ts packages/client-runtime/src/scheduledTaskSchedule.test.ts apps/server/src/scheduledTasks/Schedule.test.ts apps/server/src/scheduledTasks/ScheduledTaskService.schedule.test.ts apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts apps/server/src/scheduledTasks/legacyOnceSchedules.test.ts apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts apps/mobile/src/features/settings/scheduledTaskDraft.test.ts`
- `grep -rn 'onceAt\|schedule\.at\b' apps/web/src apps/mobile/src packages/client-runtime/src` (no hits).
- `grep -n "migrateLegacyOnceSchedules" apps/server/src/scheduledTasks/ScheduledTaskService.ts` (two hits).

### F5. Switch to turn off Git integration (server setting; web and mobile UI)

Commits `141ad94353`, `b730fd010c`.

What it does: the server setting "Git integration" (Settings → Source control). When it's off,
the server treats every folder as having no repository and starts no Git process: no
checkpoints, status, diffs, branch or PR controls, auto-pull, or worktree cleanup. Worktree
cleanup checks the setting again right before it removes anything.

Fork-owned files: none. The helper `sourceControlEnabled(settings)` lives in `serverSettings.ts`.

Touch points:

- `packages/contracts/src/settings.ts`: `sourceControlEnabled` in `ServerSettings` (default true)
  and `ServerSettingsPatch`.
- `apps/server/src/serverSettings.ts`: the `sourceControlEnabled` helper.
- `apps/server/src/vcs/VcsDriverRegistry.ts`: `detect` returns null when off, plus a resolve
  error message (+ test), and a `sourceControlEnabled` field for callers that ask a driver
  directly.
- `apps/server/src/checkpointing/CheckpointStore.ts`: `isGitRepository` returns false when off
  instead of asking Git again (upstream's fallback for unreadable repositories, November 2026).
- `apps/server/src/git/GitManager.ts`: `branchPullRequest` returns null when off (+ test).
- `apps/server/src/project/RepositoryIdentityResolver.ts`: `resolve` returns null when off
  (+ test).
- `apps/server/src/workspace/WorkspaceEntries.ts`: skips `git check-ignore` and the
  ignored-file listing when off (+ test).
- `apps/server/src/serverRuntimeStartup.ts`: `autoPullProjects` returns early (+ test).
- `apps/server/src/storageCleanup.ts`: worktree cleanup skipped, and checked again before removal
  (+ test).
- `apps/server/src/server.ts`: `Layer.provide(layerServerSettings)` on the VcsDriverRegistry,
  RepositoryIdentityResolver and WorkspaceEntries layers.
- Wiring only (each adds `ServerSettings.layerTest()`): `CheckpointStore.test.ts` (which also has
  a real test), `CheckpointDiffQuery.test.ts`, `WorkspaceFileSystem.test.ts`,
  `orchestration-v2/testkit/ProviderReplayHarness.ts`, `orchestration-v2/ProviderTurnStartService.testkit.ts`
  (on its VcsDriverRegistry layer), `apps/server/scripts/evaluate-thread-titles.ts`,
  `orchestration-v2/RunFinalizationService.test.ts` (its RepositoryIdentityResolver layer) and
  `VcsDriverRegistry.test.ts` (upstream's `makeFailingLayer`). `GitVcsDriver.test.ts` adds
  `sourceControlEnabled` to its registry stub.
- `apps/web/src/components/settings/ProjectDefaultsSettings.tsx`: the switch row.
  `settingsSearch.ts`: the `git-integration` search entry.
  `apps/web/src/components/chat/ThreadDetailsPanel.tsx`: the `show.branch` and `show.git` flags
  are false when off, so the details card has no Git rows.
- `apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx`: a "Git" section with
  the switch row, first on the `source-control` page.
- `docs/user/source-control.md`.

Verify:

- `vp test run apps/server/src/vcs/VcsDriverRegistry.test.ts apps/server/src/git/GitManager.test.ts apps/server/src/project/RepositoryIdentityResolver.test.ts apps/server/src/workspace/WorkspaceEntries.test.ts apps/server/src/serverRuntimeStartup.test.ts apps/server/src/storageCleanup.test.ts apps/server/src/checkpointing/CheckpointStore.test.ts -t "source control"`
- `grep -rln "sourceControlEnabled" apps/server/src --include=*.ts | grep -v test` (lists
  serverSettings, VcsDriverRegistry, GitManager, RepositoryIdentityResolver, WorkspaceEntries,
  serverRuntimeStartup, storageCleanup).
- Guess: after each merge, look for new upstream code that runs Git without going through
  `VcsDriverRegistry` (for example new direct `GitVcsDriver.GitVcsDriver` users). Such code
  ignores the switch.

### F6. Servers push agent activity straight to Android through Firebase (server, contracts, shared, relay, mobile)

Commits `c56b435648`, `80fc14698d`, `1a1e31d27c`, `98153a01ed`, `3df5b17129`, `e326636984`,
`a38b270057`, `be3e31bb53`, `38bd2b6992` (plus CI in C4).

What it does: a T3 server that has a Firebase service account (the server secret
`fcm-service-account`) sends agent-activity notifications and live updates straight to Android
phones through Firebase Cloud Messaging, without T3 Connect. The server advertises
`androidDirectPush.firebaseProjectId`. The fork's Android app is built with its own Firebase
project and registers with every connected server that advertises the same project ID. When you
remove an environment, the app remembers that it owes that server an unregister and sends it
the next time it can reach the server. Device rows live in a `direct_push_devices` table that the
server creates itself, so no upstream migration is involved.

Fork-owned files:

- Server: `apps/server/src/notifications/DirectPush.ts`, `DirectPushDevices.ts`, `FcmClient.ts`
  (+ `DirectPush.test.ts`, `FcmClient.test.ts`).
- Contracts: `packages/contracts/src/directPush.ts`.
- Shared (moved from `infra/relay/src/agentActivity/`, so relay and server share the payload
  logic): `packages/shared/src/agentActivityAggregate.ts`, `agentActivityAlerts.ts`,
  `agentActivityFcmPayloads.ts` (was `fcmPayloads.ts`, now also holds `androidAlertForState` /
  `androidAlertForAggregate`), `agentActivityPayloads.ts`.
- Mobile: `apps/mobile/src/features/agent-awareness/directPush.ts` (+ test),
  `directPushRegistration.ts`, `remoteRegistration.directPush.test.ts`.

Touch points:

- `packages/contracts/src/rpc.ts`: `server.registerPushDevice` and `server.unregisterPushDevice`
  (method names, `Rpc.make` definitions, `WsRpcGroup` entries).
- `packages/contracts/src/environment.ts`: the capability `androidDirectPush: { firebaseProjectId }`.
- `packages/contracts/src/index.ts`: `export * from "./directPush.ts"`.
- `apps/server/src/ws.ts`: yields `DirectPush` and adds the two RPC handlers (bound to the
  session).
- `apps/server/src/auth/RpcAuthorization.ts`: orchestration-read scope for both methods.
- `apps/server/src/observability/RpcInstrumentation.ts`: aggregates for both methods.
- `apps/server/src/server.ts`: provides the DirectPush layer (DirectPushDevices + FcmClient +
  FetchHttpClient) to `AgentAwarenessRelay.layer`.
- `apps/server/src/environment/ServerEnvironment.ts`: the descriptor advertises
  `androidDirectPush` when the FCM secret exists.
- `apps/server/src/relay/AgentAwarenessRelay.ts`: publishes each state to direct push as well
  as, or instead of, the relay; starts DirectPush; marks the startup snapshot loaded (+ test).
- `apps/server/src/ws.test.ts`: `Layer.mock(DirectPush.DirectPush)({})`.
- `apps/server/scripts/migrate-dev-db.ts`: seeded dev databases drop `direct_push_devices`, and
  skip it if the table is missing (+ test).
- `infra/relay/src/agentActivity/FcmDeliveries.ts`, `AgentActivityPublisher.ts`,
  `ApnsDeliveries.ts`, `ApnsDeliveryQueue.ts`, `infra/relay/scripts/android-push-watch.ts`, and
  relay tests: import the moved helpers from `@t3tools/shared/*`.
- `packages/shared/package.json`: four new subpath exports.
- `apps/mobile/src/Stack.tsx`: mounts `AgentAwarenessDirectPushWorker`.
- `apps/mobile/src/features/agent-awareness/remoteRegistration.ts`: the direct-push
  registration branch and pending-unregister bookkeeping; relay paths are skipped when
  `usesAndroidDirectPush()`.
- `apps/mobile/src/features/connection/useConnectionController.ts`: calls
  `forgetAgentAwarenessDirectPushEnvironment` before removing an environment.
- `apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx`: no sign-in needed in
  a direct-push build; wording.
- `apps/mobile/src/persistence/mobile-storage.ts`, `imperative.ts`: stored pending unregisters.
  `liveActivityPreferences.test.ts` and `linkEnvironment.test.ts` add the matching mocks.
- `apps/mobile/app.config.ts`: `extra.androidDirectPush.firebaseProjectId` when
  `T3CODE_ANDROID_DIRECT_PUSH=1`.
- `scripts/lib/public-config.ts`: `readGoogleServicesProjectId` (+ test).
- `docs/operations/android-notifications.md`, `docs/user/mobile-notifications.md`.

Verify:

- `vp test run apps/server/src/notifications/DirectPush.test.ts apps/server/src/notifications/FcmClient.test.ts apps/server/src/relay/AgentAwarenessRelay.test.ts apps/server/scripts/migrate-dev-db.test.ts apps/mobile/src/features/agent-awareness/directPush.test.ts apps/mobile/src/features/agent-awareness/remoteRegistration.directPush.test.ts scripts/lib/public-config.test.ts infra/relay/src/agentActivity/FcmDeliveries.test.ts`
- `grep -ln "serverRegisterPushDevice" apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/observability/RpcInstrumentation.ts packages/contracts/src/rpc.ts` (all four).
- `grep -c "AgentAwarenessDirectPushWorker" apps/mobile/src/Stack.tsx` (2).
- `ls infra/relay/src/agentActivity/{agentActivityAggregate,agentActivityAlerts,agentActivityPayloads,fcmPayloads}.ts`
  should fail. If upstream edited or re-created one of these, port the change to `packages/shared/src/`.

### F7. Android thread list as a tree (mobile, Android only)

Commits `a7e6c56c58`, `4a160a79eb`, `ad1ed9c813`, `dbeb30f38d`.

What it does: on Android, the home list and the tablet sidebar group threads under collapsible
headers, like the desktop sidebar. The headers were projects; since F20 they are folders, then
Unfiled. Rows are one line: status icon, title, time. Each group shows a few threads and a "show
more" row. Snoozed threads leave their groups for a Snoozed row at the bottom, closed unless the
user opens it (search still finds them in place). iOS keeps upstream's flat list
(`PROJECT_THREAD_TREE_ENABLED = Platform.OS === "android"`).

Fork-owned files: `apps/mobile/src/features/threads/projectThreadTree.ts` (+ test),
`project-thread-tree-items.tsx`; the folder files are listed under F20.

Touch points:

- `apps/mobile/src/features/home/HomeScreen.tsx`: overrides the `useThreadListV2` inputs when the
  tree is on (`settledLimit` infinite, settled shelf open, working shelf off); `layout="tree"` on
  rows; "older settled" row logic. The grouping itself is F20's `useThreadFolderTree`.
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`: nearly the same block.
- `apps/mobile/src/features/threads/thread-list-v2-items.tsx`: a `layout?: "flat" | "tree"` prop
  and the one-line tree row JSX (`treeContent`).
- `apps/mobile/src/features/threads/threadListV2.ts`: the tree's items in the union
  (`ThreadFolderTreeListItem`), `isThreadListV2ListItem`, equality cases.

Verify:

- `vp test run apps/mobile/src/features/threads/projectThreadTree.test.ts`
- `grep -c "PROJECT_THREAD_TREE_ENABLED" apps/mobile/src/features/home/HomeScreen.tsx apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` (6 or more each).
- `grep -n 'case "v2-folder"' apps/mobile/src/features/threads/threadListV2.ts` (one hit).

### F8. Voice input on Android through ElevenLabs (mobile, Android only)

Commits `434db9cba7`, `28d14f6f71`.

What it does: Android gets voice input. It records AAC (ADTS, 16 kHz, 48 kbps) into document
storage, so a crash doesn't lose the file. The fork's own recorder writes it, because Android's
MediaRecorder drops the last ~170 ms when it stops (the end of the last word). A recording can run up to 20 minutes and keeps going in
the background behind a notification. Since F16 the thread's server transcribes it; the ElevenLabs
key the user saves under Settings → Microphone (kept in secure storage) is only the fallback for a
server that can't. Recordings are kept until transcription succeeds, and the settings page lists
them.

Fork-owned files: `apps/mobile/src/features/voice-input/elevenLabsTranscription.ts` (key,
upload, and `androidVoiceTranscriber`), `savedRecordings.ts` (where the files live),
`apps/mobile/src/features/settings/VoiceTranscriptionSettings.tsx`, and the recorder:
`apps/mobile/modules/t3-fork-aac-recorder` (AudioRecord into MediaCodec; stop drains the
microphone and flushes the encoder before it returns; its own microphone foreground service for
background recording) with `apps/mobile/src/native/forkAacRecorder.ts`.

Upstream added its own on-device Android dictation on November 3, 2026 (`d1ec71e6ff`: Google
speech services, the `modules/t3-voice-transcription` native module and its own
`apps/mobile/src/native/voiceTranscription.android.ts`). The fork keeps that code as upstream has
it but never uses it on Android: `localVoiceTranscriberAtom` returns `androidVoiceTranscriber`
there, which builds the ElevenLabs/server transcriber as each dictation starts, so it picks up
the composer's server (F16). Upstream's user doc (`docs/user/composer.md`) describes the on-device
engine; the fork's Android build doesn't use it.
Everything else is shared with web and desktop (F14) in `packages/client-runtime/src/voice-input/`:
`elevenLabs.ts` (URL, model, retries, error messages, the transcriber and the retry from settings)
and `savedRecordings.ts` (keeping audio until its transcript is saved, listing, pruning), each with
a test.

Touch points:

- `apps/mobile/src/features/voice-input/VoiceInputProvider.tsx`: `localVoiceTranscriberAtom`'s
  `read` returns `androidVoiceTranscriber` on Android; Android recording options and
  `RECORDING_LIMIT_SECONDS`; inside `voiceInputAtom`, the session's `recordingLimitSeconds`, the
  background-recording flag, `releaseRecording` instead of delete, no cancel on background while
  Android records (in the `createVoiceRecordingPermission` callback; upstream's permission helper
  covers the permission dialog), and pruning saved transcripts once per launch.
- `apps/mobile/src/features/voice-input/voiceInputSession.ts`: the elapsed-time clamp uses
  `recordingLimitSeconds`, so the Android timer runs past five minutes.
- `apps/mobile/src/lib/audioSession.ts`: an `allowsBackgroundRecording` parameter.
- `packages/client-runtime/src/voice-input/controller.ts`: a `recordingLimitSeconds` dependency;
  passes `VoiceTranscriptionError` messages through (+ `controller.test.ts`).
- `apps/mobile/src/features/settings/SettingsVoiceRouteScreen.tsx` (upstream's Settings → Voice,
  which replaced the Microphone page on November 6, 2026): renders `<VoiceTranscriptionSettings>`
  on Android above upstream's "Transcribe on" picker, and on Android the "This device" choice says
  audio goes to the thread's server or ElevenLabs.
- `VoiceInputProvider.tsx` also builds the Android recorder with `createForkAacRecorder()`
  (falling back to `new AudioModule.AudioRecorder`) instead of upstream's `createVoiceRecorder`,
  whose live recorder writes raw PCM that the ElevenLabs/server upload and kept recordings can't
  use. Upstream's "Transcribe on:
  environment" choice still works on Android but rejects recordings over 5 minutes.
- `apps/mobile/app.config.ts`: expo-audio `recordAudioAndroid: true` and
  `enableBackgroundRecording: true`. (Upstream now lists Settings → Microphone on Android and no
  longer turns off the image picker's microphone permission, so those fork edits are gone.)

Verify:

- `vp test run packages/client-runtime/src/voice-input`; after `expo prebuild`,
  `./gradlew :t3-fork-aac-recorder:testDebugUnitTest` in `apps/mobile/android`.
- `grep -n "createForkAacRecorder" apps/mobile/src/features/voice-input/VoiceInputProvider.tsx` (the
  recorder hook).
- `grep -n "androidVoiceTranscriber" apps/mobile/src/features/voice-input/VoiceInputProvider.tsx apps/mobile/src/features/voice-input/elevenLabsTranscription.ts`
  (the provider's `read` and the export). If upstream stops reading `localVoiceTranscriberAtom`,
  move the hook to whatever replaces it.
- `grep -n "recordAudioAndroid: true\|enableBackgroundRecording: true" apps/mobile/app.config.ts` (two hits).
- `grep -n "recordingLimitSeconds\|releaseRecording(androidRecordings\|pruneSavedTranscripts(androidRecordings)" apps/mobile/src/features/voice-input/VoiceInputProvider.tsx`
  (all three still wired in), and
  `grep -n "dependencies.recordingLimitSeconds" apps/mobile/src/features/voice-input/voiceInputSession.ts`.

### F9. Fork a conversation from the mobile thread list

Commit `e37b6b0028`.

What it does: the thread row menu on mobile gets "Fork conversation".

Fork-owned files: `apps/mobile/src/features/home/thread-fork.ts` (+ test), `useThreadForkAction.ts`.

Touch points:

- `apps/mobile/src/features/home/HomeRouteScreen.tsx`: hook and `onForkThread` prop.
- `apps/mobile/src/features/home/HomeScreen.tsx`: passes `onForkThread` through.
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`: hook and prop.
- `apps/mobile/src/features/threads/thread-list-v2-items.tsx`: `FORK_CONVERSATION_MENU_ACTION`,
  the handler line and the `onForkThread` prop.
- `apps/mobile/src/features/home/useThreadListActions.ts`: exports `checkThreadOperationPermission`.
- Depends on F3's `threadEnvironment.forkFromLatestStable` (client-runtime).
  `apps/mobile/src/features/home/useThreadForkAction.ts` waits up to 5 seconds for the new thread
  itself, since upstream replaced `waitForThreadShellReady` with a 2-second `waitForThreadShell`.

Verify:

- `vp test run apps/mobile/src/features/home/thread-fork.test.ts`
- `grep -n "FORK_CONVERSATION_MENU_ACTION" apps/mobile/src/features/threads/thread-list-v2-items.tsx` (two hits).

### F10. Archive a thread from its header menu (mobile)

Commit `ec99764996`.

What it does: the thread screen's header overflow menu has "Archive thread". It leaves the
thread right away, before the server answers.

Touch points:

- `overflowOnly` on `AppBarAction` is upstream's since November 3, 2026.
- `apps/mobile/src/features/threads/ThreadHeader.tsx`: the `onArchiveThread` prop; the action is
  pushed onto upstream's single AppBar `actions` list with `overflowOnly`, Android only.
- `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`: wires
  `useOpenThreadArchiveAction(useWorkspaceListNavigation("threads"))`, only when the thread can
  be changed, isn't being created and isn't archived.
- `apps/mobile/src/features/layout/workspace/useAndroidWorkspaceNavigation.ts`: exports
  `useWorkspaceListNavigation`, which upstream keeps private.
- `apps/mobile/src/features/home/useThreadListActions.ts`: `useOpenThreadArchiveAction`
  (+ `useThreadListActions.test.ts`).

Verify:

- `vp test run apps/mobile/src/features/home/useThreadListActions.test.ts`
- `grep -n "onArchiveThread" apps/mobile/src/features/threads/ThreadHeader.tsx apps/mobile/src/features/threads/ThreadRouteScreen.tsx`

### F11. Take a photo from the composer's attachment menu (mobile)

Commit `1d59be06ce`.

What it does: the composer's "+" menu offers "Take Photo" (camera) next to "Photo Library", in
question attachments too. The menu also shows when the server doesn't support file attachments.

Touch points:

- `apps/mobile/src/lib/composerImages.ts`: `takeComposerPhoto` (+ test).
- `apps/mobile/src/state/use-composer-attachment-actions.ts`: `onTakeDraftPhoto`.
- `apps/mobile/src/state/use-thread-composer-state.ts`: returns it.
- `ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx`, `ThreadComposer.tsx`, `NewTaskDraftScreen.tsx`
  (in `apps/mobile/src/features/threads/`): pass the `onTakeDraftPhoto` prop through (1–3 lines each).
- `apps/mobile/src/features/threads/ComposerAttachmentButton.tsx`: camera item; the menu is
  always shown.
- `apps/mobile/src/features/threads/QuestionAttachments.tsx`: a `"camera"` kind.
- `apps/mobile/app.config.ts`: camera permission text.

Verify:

- `vp test run apps/mobile/src/lib/composerImages.test.ts`
- Typecheck catches a dropped prop. `grep -n '"camera"' apps/mobile/src/features/threads/ComposerAttachmentButton.tsx`

### F12. Thread list recovers after a subscription defect (client-runtime; all clients)

Commit `d49219f55d`.

What it does: if the subscription feeding the thread list dies with a defect, it retries with
backoff (1 s up to 30 s). Before, the list stayed frozen until the app restarted.

Touch points: `packages/client-runtime/src/state/shell.ts` (+ `shell-sync.test.ts`).

Verify: `vp test run packages/client-runtime/src/state/shell-sync.test.ts -t "resubscribes after a defect"`.
If upstream adds its own retry here, drop this one.

### F13. T3 Code as Android's digital assistant (mobile, Android only)

What it does: the app shows up in Settings > Apps > Default apps > Digital assistant app. When it
is chosen there, holding the power button (or swiping up from a bottom corner) opens a new thread
in the server's new-thread project (F20), else the build's assistant project, a fresh draft each
time, already recording through the F8 voice input (tap ✓ to drop the words into the draft, × to
type instead). The nightly sets the build's project folder with `T3CODE_ASSISTANT_PROJECT_ROOT`
(`/home/daddy/agents`, the root project). With neither, or no connected project at the folder, it
opens Choose project instead. Android only needs an activity that
handles `ACTION_ASSIST`; there is no voice interaction service, so there's no overlay on top of
the current app and no screen context.

Fork-owned files: `apps/mobile/plugins/withAndroidAssistant.cjs` adds an `ASSIST` intent filter to
`MainActivity`, plus code that turns an assist launch into a `<scheme>://assist` link (in
`onCreate`, before React Native reads the launch URL, and in `onNewIntent`).
`apps/mobile/src/features/assistant/` holds `useAssistantLaunch.ts`, which waits for the project
and opens the draft, `assistantDictation.ts`, which starts recording in that draft's composer, and
`assistantLaunch.ts` (+ test, which covers both).

Touch points:

- `apps/mobile/app.config.ts`: the plugin line and `extra.assistantProjectRoot`.
- `apps/mobile/src/Stack.tsx`: `useAssistantLaunch()` in `RootStackLayout`.
  `useAssistantLaunch.ts` imports from `features/layout/workspace/`.
- `apps/mobile/src/lib/appLinking.ts`: `shouldHandleAppLink` ignores the assist link, so the
  router doesn't open NotFound for it.
- `useAssistantLaunch.ts` asks `newThreadProjectDraft(launchId)` (F20, `threadFolderActions.ts`)
  before the build's folder.
- `apps/mobile/src/features/threads/ThreadComposer.tsx`: `useAssistantDictation(...)` right after
  `useVoiceInputController(...)`, passing `props.draftKey` only for new drafts (not
  `composerDraftKey`, which stands in a placeholder key until the draft exists).
- `.github/workflows/custom-nightly-linux.yml`: `T3CODE_ASSISTANT_PROJECT_ROOT` in the Android job.

Verify:

- `vp test run apps/mobile/src/features/assistant/assistantLaunch.test.ts`
- After `expo prebuild --platform android`: `grep -n "intent.action.ASSIST" apps/mobile/android/app/src/main/AndroidManifest.xml`
  (one hit) and `grep -c "assistIntentAsLink" apps/mobile/android/app/src/main/java/com/*/*/MainActivity.kt` (three).
  The prebuild throws if upstream's MainActivity template loses an anchor.
- On a device or emulator with the APK installed:
  `adb shell cmd role add-role-holder android.app.role.ASSISTANT com.willsmanley.t3code`, then
  `adb shell input keyevent KEYCODE_ASSIST` opens a new thread in the assistant project, both when
  the app is closed and when it is in the background, with the recording timer running (or the
  "Add an ElevenLabs API key" notice when none is saved).

### F14. Voice input on web and desktop through ElevenLabs (web/desktop)

Added October 30, 2026.

Upstream added its own web and desktop voice input on November 6, 2026 (`b8dce83214`,
`a9a1b8c4be`): a local speech model on a chosen environment, off until **Settings → Voice → Send
microphone audio to** names one, with its own button (`ComposerSpeechButton`, `useEnvironmentSpeechInput`,
**Composer: Dictation** `mod+shift+d`). The fork's ElevenLabs mic stays and both can show at once
when a device opts in. Until then the composer passes `offerSetup: false` (November 11, 2026), so
upstream's button stays hidden instead of showing a second mic whose first click opens Voice
settings, the same as upstream's other editors. ChatComposer combines them (`voiceInputBusy || speechInput.freezesEditor`,
and the send-disabled reason). `apps/web/src/speech/useEnvironmentSpeechInput.ts` wraps
`controller.stop()` so upstream's `stop` still resolves `void` (the fork's resolves whether the
transcript landed, F16). `Space` in `EVENT_CODE_SHORTCUT_KEYS` now lives in
`packages/shared/src/keybindingMatching.ts`.

What it does: the composer gets a mic button beside send. It records with the browser's
`MediaRecorder` and transcribes with the same ElevenLabs Scribe call as Android (F8), through
upstream's shared `VoiceInputController`, so the transcript lands at the cursor with the same
draft checks as mobile. While it records or transcribes, the editor is read-only and send is off;
× cancels, ✓ transcribes. **Composer: Voice Input** (`ctrl+space` on every platform by default, since `mod+space` is Spotlight on macOS; added November 3, 2026) presses the mic, then ✓ (send). While recording, Enter sends, Shift+Enter only fills the draft, and Escape cancels. Recordings stop at 20
minutes, like Android. The API key is saved once
on the server, in its secret store as `<base-dir>/userdata/secrets/elevenlabs-api-key.bin` (mode
600). Since F16 the audio streams to the thread's server, which transcribes it. Only when that server
can't (older, or unreachable for 90 seconds) does the client ask it for the key over the
`server.getElevenLabsApiKey` RPC (operate scope, which can already run commands there) and upload
straight to ElevenLabs. Nothing is pasted in a browser or the desktop app; Android still keeps its
own key (F8). Recordings are kept exactly as on
Android, by the same shared code: audio is saved to IndexedDB a second at a time while recording,
deleted only once its transcript is saved, and listed under Settings → Chat → Voice input with
Transcribe, Copy and Delete. That retry asks each connected server for the key in turn. The
browser only allows the microphone over HTTPS or localhost.

Fork-owned files: `packages/client-runtime/src/voice-input/elevenLabs.ts` (shared with F8),
`packages/client-runtime/src/voice-input/savedRecordings.ts` (+ test, shared with F8),
`apps/web/src/voiceInput/elevenLabsVoiceInput.ts` (recorder, transcriber, key request),
`apps/web/src/voiceInput/savedRecordings.ts` (IndexedDB storage),
`apps/web/src/components/chat/useComposerVoiceInput.ts`,
`apps/web/src/components/chat/ComposerVoiceInputControl.tsx`,
`apps/web/src/components/settings/VoiceRecordingsSettings.tsx`, and
`apps/server/src/voiceInput/elevenLabsApiKey.ts` (+ test).

Touch points:

- `packages/client-runtime/src/voice-input/index.ts`: re-exports `elevenLabs.ts` and
  `savedRecordings.ts`.
- `apps/web/src/components/settings/SettingsPanels.tsx`: `<VoiceRecordingsSettingsSection />` at
  the end of `ChatSettingsPanel`.
- `apps/web/src/components/settings/settingsSearch.ts`: the `voice-recordings` item.
- `apps/web/src/components/chat/ChatComposer.tsx`: two imports; the voice block right after
  `applyPromptReplacementStable` (owner key, `readVoiceInputDraft`, `commitVoiceInputDraft`,
  `useComposerVoiceInput`); `voiceInputBusy` in `submitComposer`'s guard, the editor's `disabled`
  and the footer's `sendDisabledReason`; `<ComposerVoiceInputControl>` before
  `<ComposerFooterPrimaryActions>`.
- `packages/contracts/src/rpc.ts`: `server.getElevenLabsApiKey` (method name, `Rpc.make`
  definition, `WsRpcGroup` entry).
- `apps/server/src/ws.ts`: the `ServerSecretStore` import, `secretStore` beside `directPush`, and
  the handler before `cloudGetRelayClientStatus`.
- `apps/server/src/auth/RpcAuthorization.ts`: operate scope.
- `apps/server/src/observability/RpcInstrumentation.ts`: the `server` aggregate.
- `apps/web/tsconfig.json`: `ES2024.Promise` in `lib`, because the shared controller uses
  `Promise.withResolvers`.
- `packages/contracts/src/keybindings.ts`: `"composer.voiceInput"` after `"composer.branch"`;
  `packages/shared/src/keybindings.ts`: its `ctrl+space` default after
  `composer.previousWorktree`, and `Space: " "` in `EVENT_CODE_SHORTCUT_KEYS`, because Electron on
  Linux reports Ctrl+Space with key `Unidentified`. The handler lives in
  `ComposerVoiceInputControl.tsx`.

Verify:

- `vp test run packages/client-runtime/src/voice-input apps/server/src/voiceInput`
- `grep -c "voiceInputBusy" apps/web/src/components/chat/ChatComposer.tsx` (four),
  `grep -c "offerSetup: false" apps/web/src/components/chat/ChatComposer.tsx` (one),
  `grep -c "<ComposerVoiceInputControl" apps/web/src/components/chat/ChatComposer.tsx` (one) and
  `grep -c "<VoiceRecordingsSettingsSection" apps/web/src/components/settings/SettingsPanels.tsx` (one).
- `grep -n "composer.voiceInput" packages/contracts/src/keybindings.ts packages/shared/src/keybindings.ts apps/web/src/components/chat/ComposerVoiceInputControl.tsx`
  (one hit in each, two in the control).
- `grep -ln "serverGetElevenLabsApiKey" apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/observability/RpcInstrumentation.ts packages/contracts/src/rpc.ts` (all four).
- If upstream ships its own web voice input, compare the two and drop this one.

### F15. Faster return to the Android app (client-runtime, mobile)

Added October 31, 2026.

What it does: coming back to the app after a while shows the saved thread list and messages at
once and catches up quietly.

- The faster check of the old connection after a long time away is upstream's since November 6,
  2026 (`LONG_RESUME_PROBE_TIMEOUT`, 1.5 seconds); the fork's 1-second version and its test were
  dropped.
- With saved threads on screen, "Syncing threads...", "Reconnecting to ..." and "Syncing
  messages..." wait 4 seconds before they show (upstream: 0.8 and 0.4 seconds). Offline, errors and
  an empty list still show at once.

Fork-owned files: `apps/mobile/src/features/home/workspace-connection-status-delay.ts` (+ test).

Touch points:

- `apps/mobile/src/features/home/WorkspaceConnectionTitle.tsx`:
  `workspaceConnectionStatusShowDelayMs(state)` replaces `STATUS_SHOW_DELAY_MS`.
- `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`: `CATCH_UP_SHOW_DELAY_MS` as the third
  argument of the `threadSyncLabel` `useDelayedStatus` call.

Verify:

- `vp test run apps/mobile/src/features/home/workspace-connection-status-delay.test.ts`
- `grep -n "workspaceConnectionStatusShowDelayMs" apps/mobile/src/features/home/WorkspaceConnectionTitle.tsx`
  and `grep -n "CATCH_UP_SHOW_DELAY_MS" apps/mobile/src/features/threads/ThreadDetailScreen.tsx`.

### F16. Dictation streams to the server, and ✓ sends the message (all clients)

Added November 1, 2026.

What it does: while you talk, web, desktop and Android send the recording to the thread's server
about once a second over two RPCs, `voice.appendAudio` and `voice.transcribe` (operate scope). When
the recording stops only the last second is still uploading, and the server sends the audio to
ElevenLabs Scribe v2 over its own fast link (per-attempt timeout, three retries). The transcript
comes back to the client, which puts it in the draft and sends the message the way the send button
does, so an agent that is still working follows the follow-up setting (steer by default). Holding
✓ (or Shift-clicking it on web and desktop) only puts the words in the draft. Every dictation
writes one line to `<userdata>/logs/voice-dictation.ndjson` (sizes and timings, no words). The
server keeps a recording's audio until it is transcribed and the transcript for a week, in
`<userdata>/voice-dictation/`, so a client that loses its connection can ask again. Web records
Opus at 24 kbps (48 kbps for MP4), Android AAC at 16 kHz and 48 kbps; tests on real and LibriSpeech
audio found no accuracy loss against lossless at those rates. A client whose server lacks the RPCs
or stays unreachable uploads straight to ElevenLabs as before, now with a 90-second limit on each
attempt.

Fork-owned files: `packages/contracts/src/voiceDictation.ts`,
`apps/server/src/voiceInput/VoiceDictation.ts` (+ test),
`packages/client-runtime/src/voice-input/serverDictation.ts` (+ test) and `serverDictationRpc.ts`,
`apps/mobile/src/features/voice-input/useDictationSend.ts`.

Touch points:

- `packages/contracts/src/rpc.ts`: the two method names, `Rpc.make` definitions and `WsRpcGroup`
  entries; `packages/contracts/src/index.ts`: the export.
- `apps/server/src/ws.ts`: the import, `voiceDictation` beside `secretStore`, and the two handlers
  after `serverGetElevenLabsApiKey`; `apps/server/src/server.ts`: `VoiceDictation.layer` after the
  `DirectPush` block; `RpcAuthorization.ts` (operate scope) and `RpcInstrumentation.ts`; and
  `ws.test.ts`: the `VoiceDictation` mock layer.
- `packages/client-runtime/src/voice-input/controller.ts`: `stop()` resolves true once the transcript
  is in the draft (+ `controller.test.ts`); `elevenLabs.ts`: the per-attempt timeout; `index.ts`:
  the exports.
- Web: `elevenLabsVoiceInput.ts` (server transcriber with the direct fallback, the live recording
  kept in memory, `audioBitsPerSecond`), `useComposerVoiceInput.ts` (`stopAndSend`),
  `ComposerVoiceInputControl.tsx` (send, hold or Shift-click to edit), and in `ChatComposer.tsx`
  the `onConfirm`/`onConfirmWithoutSending` props.
- Android: `elevenLabsTranscription.ts` (server transcriber, `setDictationEnvironment`, reading the
  growing file); `VoiceInputProvider.tsx` (recording options and `streamRecordingAudio` in
  `sampleRecording`); `useVoiceInputController.ts` (`environmentId`); `ThreadComposer.tsx`
  (`environmentId`, `useDictationSend`, `onConfirmLongPress`); `ComposerDictationControl.tsx`
  (`onConfirmLongPress` and the send label); `voiceInputSession.test.ts` (`Promise<boolean>`).

Verify:

- `vp test run apps/server/src/voiceInput packages/client-runtime/src/voice-input`
- `grep -ln "voiceDictationAppend" apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/observability/RpcInstrumentation.ts packages/contracts/src/rpc.ts`
  (all four) and `grep -n "VoiceDictation.layer" apps/server/src/server.ts`.
- `grep -n "stopAndSend\|onConfirmWithoutSending" apps/web/src/components/chat/ChatComposer.tsx`,
  `grep -n "useDictationSend\|onConfirmLongPress\|environmentId: props.environmentId" apps/mobile/src/features/threads/ThreadComposer.tsx`
  and `grep -n "streamRecordingAudio" apps/mobile/src/features/voice-input/VoiceInputProvider.tsx`.
- After a dictation, a `transcribed` line appears in `<userdata>/logs/voice-dictation.ndjson`.

### F17. Prime Agent provider (server, contracts, all clients)

Added November 1, 2026.

What it does: adds Prime Intellect's `prime-agent` as a provider (driver `prime`, off until an
instance enables it). T3 runs `prime-agent --mode acp` through the shared ACP adapter. Models come
from `prime-agent model list` as `provider/model` (Prime's ACP value is a JSON `[provider, model]`
pair). There is no "Prime default" entry: Prime saves every model switch as its default, so it
meant whichever model any session used last; older threads that carry the `default` slug keep their
session's model. Reasoning offers Off to High, the levels Prime gives models without a level map in
its config; a thread without a stored level runs at high, and a stored level the model lacks (Extra
High or Max from older threads) runs at the highest level it offers. Every action is a Python cell, shown with its code.
T3's MCP tools reach Prime over HTTP. Only Full access is offered: Prime never asks before acting.
Prime 0.10.2 cannot load or resume an ACP session and names each connection's session itself, so
each T3 session gets its own id and directory (`<userdata>/prime-agent/<instance>/<id>`); reopening
relaunches Prime there with `--continue`, and `withPrimeStableSession` shows T3 only that id
(`session/resume` answers for it, forwarded updates carry it). When Prime's background service
restarts (`prime-agent update`, a crash), its ACP process fails every prompt with "the daemon
connection is closed"; that turn fails with a plain message and the next one relaunches Prime on the
same session. Failed turns show Prime's own reason. No app text generation: titles and commit
messages come from another provider.

Fork-owned files: `packages/provider-prime/**`,
`apps/server/src/orchestration-v2/Adapters/PrimeAdapterV2.test.ts`.

Touch points:

- `apps/server/src/policy/managedProviders.ts`: `primeClient` in `PACKAGED_CLIENTS`, so a managed
  policy can name the `prime` driver (upstream's test allows every built-in driver).
- `apps/server/src/provider/builtInDrivers.ts`: import, `PrimeDriverEnv`, `PrimeDriver` before
  `AcpRegistryDriver`; `apps/server/package.json`: the dependency.
- `packages/client-runtime/src/providerClients.ts`: `primeClient` (web and mobile both read it);
  `packages/client-runtime/package.json`: the dependency.
- `packages/contracts/src/model.ts`: `PRIME_DRIVER_KIND` in `DEFAULT_MODEL_BY_PROVIDER` and
  `PROVIDER_DISPLAY_NAMES`; `packages/contracts/src/settings.ts`: `"prime"` in
  `DEFAULT_DISABLED_PROVIDER_DRIVERS`.
- Root `package.json` (knip workspace list) and `scripts/release-smoke.ts` (workspace manifests).
- `packages/provider-acp/src/server/adapter.ts`: the `relaunchOnActiveSession` flavor field and its
  use in `restartAcpRuntime` (the replacement process launches on the active session).
- `apps/server/src/provider/ProviderRegistry.ts`: a `prime` branch in
  `shouldRetainMissingProviderModels`, so a ready probe drops cached models Prime no longer lists
  (the retired "default"); test in `ProviderRegistry.test.ts`.

Verify:

- `vp test run packages/provider-prime apps/server/src/orchestration-v2/Adapters/PrimeAdapterV2.test.ts`
- `grep -n "relaunchOnActiveSession" packages/provider-acp/src/server/adapter.ts` (field and use).
- `grep -n "PrimeDriver" apps/server/src/provider/builtInDrivers.ts` and
  `grep -n "primeClient" packages/client-runtime/src/providerClients.ts`.
- With `prime-agent` installed, a Prime thread keeps its conversation across a server restart.

### F18. Workers tab, Needs you and worker threads (web, server, client-runtime, contracts, mobile)

Added November 5, 2026.

What it does: a thread is either a normal thread (Projects) or a worker, chosen by the user. A
worker is a thread with the upstream thread tag `worker` (`WORKER_THREAD_TAG`, `isWorkerThread`),
so no schema or migration is involved. The legacy sidebar gets Projects and Workers tabs. Workers
lists worker threads by folder (F20), with the same New folder button as Projects, then "Jobs in
project threads" (scheduled tasks outside worker threads); jobs whose thread is archived and that won't run again hide behind "Show archived".
A "Needs you" group at the top of Projects shows a worker that waits on the user (question,
approval) or failed, a job whose last run failed (until "Mark done", kept in localStorage), and a
job that would still run into an archived thread. Right-click a project thread for "Move to
Workers", a worker for "Move to Projects"; archiving from Workers pauses the worker's jobs first.
A worker's finished runs stay quiet: no browser notification, no phone card or completion alert
(questions, approvals and failures still push). Clicking a worker whose thread is archived opens
it with `?archived=true`, which lets the thread route show an archived (never a deleted) thread,
with an "archived" composer banner and Unarchive. Both phone apps offer the same move in the
long-press menu.

Android app: the bottom bar is Projects | Workers | Usage | Settings, like the sidebar tabs.
Projects is the thread list without quiet workers (one that needs the user stays). Workers lists
every worker thread by folder (F20), then "Jobs in project threads" from the server's scheduled
tasks (a job opens its thread, or Settings > Scheduled tasks when it starts a new thread each
run); with no worker in view it says how to make one. Pulls left the bar: it comes after the
bar's three sections, so it is the first row of Settings (the tablet rail still lists it). The
tab order isn't customizable, so a saved order from an older build can't put Pulls back. iOS
keeps its tabs and hides workers into a collapsed "Workers (N)" group at the end of its list.

Fork-owned files:

- Contracts: `packages/contracts/src/workerThreads.ts`.
- Web: `apps/web/src/components/LegacySidebarWorkers.tsx`, `legacySidebarWorkers.logic.ts`
  (+ test), `apps/web/src/components/chat/useArchivedThreadBanner.tsx`.
- Server: `apps/server/src/relay/workerThreadAwareness.ts`.
- Mobile: `apps/mobile/src/features/threads/workerThreads.ts`, `workerThreadGroup.ts` (+ test),
  `use-worker-thread-group.ts`, `workerThreadTag.ts`, `workerJobs.ts` (+ test),
  `worker-jobs-section.tsx`, and the bar icons `t3_projects.xml` and `t3_workers.xml` in
  `apps/mobile/modules/t3-native-controls/android/src/main/res/drawable/`.

Touch points:

- `packages/contracts/src/index.ts`: exports `workerThreads.ts`.
- `packages/client-runtime/src/operations/commands.ts` (`setThreadTag`) and
  `src/state/threadCommands.ts` (`setTag`): a client command for upstream's `thread.tag.set`.
- `apps/web/src/components/LegacySidebar.tsx` (fork-owned copy): the tabs, Needs you and the
  Workers list in `SidebarProjectsContent`, `workerProjects`, and `legacyThreadWorkerMenu` in the
  thread context menu. `LegacySidebar.snooze.tsx` (F2) drops worker threads from the project
  tree and Snoozed.
- `apps/web/src/components/ThreadNotificationCoordinator.tsx`: no completion notification for a
  worker.
- `apps/web/src/threadRoutes.ts` (`allowArchived`, `validateThreadRouteSearch`, + test),
  `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` (`validateSearch`),
  `apps/web/src/components/ThreadRouteView.tsx` (reads `archived`), `ChatView.tsx` (the banner).
- `apps/server/src/relay/AgentAwarenessRelay.ts`: `quietWorkerAwarenessState` in the publish
  snapshot and the startup catch-up, `thread.tags-updated` publishes, and a worker's finished run
  doesn't alert after the tag is removed (+ tests). `ProjectionStore.ts`: the awareness snapshot
  carries `tags` (+ test).
- Mobile list: `threadListV2.ts` (the shelf and jobs items), `thread-list-v2-items.tsx`,
  `projectThreadTree.ts` (one export), `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` (a
  `workers` prop: `useWorkerThreadGroup({ tab })`, the jobs item, no reordering of workers),
  `home/HomeRouteScreen.tsx` and `layout/workspace/WorkspaceThreadSidebar.tsx` (a `workers` prop
  with its own search query, no new-thread button), `WorkspaceListHeader.android.tsx` and
  `.types.ts` (`tab`).
- Mobile tabs: `layout/workspace/navigation-tab-order.ts` (`workers` in `NAVIGATION_TAB_ORDER`,
  labels, `ANDROID_NAVIGATION_TAB_ORDER`, a `capacity` for `overflowNavigationTabs`),
  `navigation-tabs.ts` (`WORKERS_TAB_ENABLED`, the platform order, iOS hides `workers`,
  `PHONE_NAVIGATION_TAB_CAPACITY`), `workspace-tabs-state.ts` (`resolveWorkspaceTabOrder`
  defaults, `workers` state and columns), `WorkspaceTabsContext.tsx`,
  `AndroidWorkspaceNavigation.android.tsx` (bar capacity), `WorkspaceRootScreen.android.tsx` and
  `AndroidWorkspaceSidebar.android.tsx` (render Workers), `workspace-tab-navigation.ts` (a
  worker's detail is a thread), `WorkspaceToolbar.tsx` (search label type; upstream merged the iOS toolbar into it on November 9, 2026),
  `home/AndroidHomeFab.android.tsx`, `settings/SettingsRouteScreen.tsx` and
  `SettingsNavigationRouteScreen.tsx` (capacity), `T3WorkspaceNavigationModule.kt` (Projects and
  Workers titles and icons).

Verify:

- `vp test run apps/web/src/components/legacySidebarWorkers.logic.test.ts apps/web/src/threadRoutes.test.ts`
- `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts`
- `vp test run apps/mobile/src/features/threads/workerThreadGroup.test.ts apps/mobile/src/features/threads/workerJobs.test.ts apps/mobile/src/features/layout/workspace/navigation-tab-order.test.ts apps/mobile/src/features/layout/workspace/workspace-tabs-state.test.ts`
- In the legacy sidebar, "Move to Workers" moves a thread to the Workers tab and back.
- In the Android app the bar reads Projects, Workers, Usage, Settings; Settings starts with
  Pulls; "Move to Workers" on a Projects thread moves it to the Workers tab, and "Move to
  Projects" brings it back.

### F19. Rebound Cmd+arrow shortcuts work from the composer (web/desktop, Mac)

Added November 6, 2026.

What it does: on a Mac the composer takes Cmd+Up/Down (start or end of the message) and
Cmd+Left/Right (start or end of the line) and stops the key there. When a keybinding is bound to
one of those keys, such as `mod+arrowup` for `thread.previous`, the composer now leaves the key to
the app, so the shortcut works while typing. Unbound, the keys move the caret as before.

Touch points:

- `apps/web/src/components/ComposerPromptEditorTiptap.tsx`: the `isAppShortcut` prop, in
  `readCallbacks`, checked at the top of the Mac boundary branch in `handleKeyDown`.
- `apps/web/src/components/chat/ChatComposer.tsx`: `isAppShortcutStable` (resolves the key with
  `composerFocus`) passed to the editor.

Verify:

- `vp run --filter ./apps/web typecheck`
- With `{ "key": "mod+arrowup", "command": "thread.previous" }` in `keybindings.json`, Cmd+Up in
  the composer switches threads; with no such binding it moves the caret to the start.

### F20. Folders replace projects in the legacy sidebar and the phone app (web/desktop, server, client-runtime, contracts, mobile)

Added November 6, 2026; the phone app November 7, 2026; folders kept on the server November 11,
2026; the new-thread project and auto-filing November 11, 2026.

What it does: the legacy sidebar's Projects tab lists folders, then Unfiled, instead of projects.
Once a folder exists, an empty Unfiled is hidden (`UnfiledFolderRow`, November 11, 2026); it shows
while threads are dragged, so they can be dropped there, and whenever a thread lands in it. ⌘N
starts a new thread when it is hidden. A folder only labels threads; it never changes where a thread's agent runs. A thread is in folder
`X` when it has the upstream thread tag `folder:X` (set with F18's `thread.tag.set` client
command), so archiving keeps the folder. Moving a thread adds the new tag before removing old
ones, and the newest folder tag wins. Folder names are trimmed, one line, at most 56 characters.

Each server keeps the folder list: order, empty folders, collapse state (Unfiled too) and one
default folder, in `<userdata>/thread-folders.json`. Clients read it through the stream
`threadFolders.subscribe` (read scope) and change it with `threadFolders.update` (operate scope:
create, rename, delete, reorder, setCollapsed, setDefault, seedFromDevice); servers advertise
`threadFolders: true` in their config. Rename and delete run on the server and retag every thread
in the folder, archived ones included (a deleted folder's threads go to Unfiled). Folders known
only from thread tags (an older client made them) list after the server's, by name. With several
servers connected, the one a user changed most recently leads and the others add their folders
after it; writes go to every connected server that keeps folders. Clients show a change at once
and drop that guess when the server answers.

Default folder: "New threads go here" in a folder's menu (desktop right-click or "…", phone
long-press); "Stop sending new threads here" clears it. A muted "default" sits next to the
folder's name. The server applies it in the `orchestration.launchThread` handler, the RPC only the
user's own clients call when a draft is sent, by adding the folder tag to `thread.create` (new
optional `tags`), so the thread is created already filed. A launch's `folder` (the folder's
new-thread button: its name; Unfiled's: null) wins over the default. Subagent and child threads,
`delegate_task` and other MCP launches, scheduled tasks, the startup thread, ACP imports and forks
never pass through that handler, so they never get it; worker threads only become workers after
they exist.

New-thread project: `newThreadProjectId` in the same file (`setNewThreadProject`; a project id
names one server's project, so a client sends the id to that server and clears it on the others).
When it names a live project, every new thread the user starts begins there: desktop ⌘N and the
command palette's "New thread in …" (`startNewThreadFromContext` in `lib/chatThreadActions.ts`), a
folder's and Unfiled's new-thread buttons, the landing draft (`routes/_chat.index.tsx`), the phone's
New thread button (`AdaptiveWorkspaceLayout.tsx`) and folder pencils, and the F13 assistant. Unset,
each keeps its own choice. "New threads start here" sits on a project's settings page (desktop
`settings/NewThreadProjectSettingsRow.tsx` in `ProjectSettingsPanel.tsx`; phone
`threads/NewThreadProjectSection.tsx` in `SettingsProjectOverviewRouteScreen.tsx`), and the desktop
palette offers "Start new threads in <project>" for the open thread. Explicit project picks ("New
thread in…" submenu, a thread's "New thread in this project", MCP, `delegate_task`, scheduled
tasks) are untouched, and existing threads keep their projects.

Auto-filing: `autoFile` in the same file (`setAutoFile`, on by default; desktop sidebar options menu
and palette, phone Unfiled long-press). The `launchThread` handler adds the tag `autofile:pending`
to a thread that ends up in no folder, when its title will be generated and the server has
folders: the new-thread shortcut and phone New thread button without a default folder, and Unfiled's
button (its `folder: null` skips only the default folder). A folder's button files the thread there
and never waits. MCP, `delegate_task`, scheduled tasks, subagents and workers never reach that
handler. The thread's first title call (`ThreadTitleRegenerationService`, same model as the title)
is then also offered the folder names with up to three recent titles each, hand-filed threads
first (`ThreadAutoFile.folderChoice`; the prompt section and the optional `folder` reply key are in
`packages/provider-core/src/server/threadFolderPrompt.ts`). After the title, `ThreadAutoFile.finish`
re-reads the thread: if it still has `autofile:pending`, no folder tag, isn't a worker and the
switch is on, and the answer names an offered folder, it adds `folder:X` and `autofile:filed`; it
always removes `autofile:pending`. A null or unknown answer leaves the thread in Unfiled. Any move
by a client removes both tags (`fileThreads`), so a late answer never overrides the user. Rows
with `autofile:filed` show a quiet mark (desktop bot icon, phone "auto") until the user moves the
thread or opens its menu (desktop thread or multi-select context menu, palette "Move to folder…",
phone long-press via `onOpenMenu`, which `Menu.android.tsx` now fires). The extra cost is a few
hundred input tokens and one short field on a call that already runs; no extra model call.

Migration: a server with no `thread-folders.json` builds one from the folder tags on unarchived
threads, most recently active folder first (an archived thread's tag may name a folder deleted on
another device). Until a user changes that list (`updatedAt` null), the first new client that
still has a saved device list (web localStorage `t3code:legacy-sidebar-folders:v1`; phone
preferences `threadFolders`, `collapsedThreadFolders`, `unfiledThreadsCollapsed`) sends it once
with `seedFromDevice`, which puts that order and collapse state first. A client deletes its saved
list once every connected server that keeps folders has a user-changed list. Folders picked for
unsent drafts stay on the device (web `t3code:legacy-sidebar-draft-folders:v1`, phone
`pendingThreadFolders`).

Compatibility: older clients keep working against a new server; they read and write the same
tags, keep their own order, and their threads get the default folder when they start one. A new
client against an older server shows folders from tags for the session only (no default folder
item), retags loaded threads itself on rename and delete, and files a draft's thread after it
exists, since the older server drops the launch's `folder`.

- Drag folder headers to reorder them; drag a thread row (or the selection) onto a folder, or
  onto Unfiled to take it out of its folder.
- Thread menu and multi-select menu: "Move to folder ›" (folders, "New folder…") and "Remove from
  folder". Folder header (right-click or "…"): Rename (a taken name merges), New threads go here,
  and Delete folder (threads go to Unfiled, confirmed when not empty). The tab header's folder
  button makes a folder; "Add project" lives in the command palette.
- A folder's new-thread button starts a draft in the project of the folder's most recently
  active thread (else the open thread's, else the first project), and the draft's first message
  launches the thread in that folder. Other new threads land in the default folder, if any.
- Until a folder exists, Unfiled offers "Make a folder for each project": one folder per
  project, in project order and named after it, with each listed thread filed under its project.
- Command palette: "Move to folder…" for the open thread (pick a folder, or type a new name) and
  "New folder".
- Workers tab: worker threads are grouped by the same folders, with the same menu; collapsing a
  folder there collapses it everywhere.
- Thread traversal and the Cmd+1–9 jump hints follow the folders as shown. In a folder that mixes
  projects, a row's title tooltip adds the project name (the row itself shows only the title).

Phone app (Android tree, F7): the Projects tab (home list and tablet sidebar) groups threads by
the same folders, then Unfiled. The Workers tab (F18) lists workers by them too, showing only
folders that hold a worker plus Unfiled (always, for its New folder button), without new-thread
buttons. Search opens every folder and lists only
folders with matches; a project or environment filter hides empty folders.

- Thread long-press: "Move to folder ›" (folders, the current one checked, "New folder…") and
  "Remove from folder", on iOS too.
- Folder header: tap collapses; long-press offers Rename…, New threads go here, New folder…,
  Arrange folders… (a drag sheet), Move up / Move down and Delete folder (confirmed when not
  empty). Unfiled's long-press offers New folder… and Arrange; its folder button makes a folder.
- A header's new-thread button opens a draft in the project of the folder's most recently active
  thread (else the first project). The draft's route `requestId` keys the picked folder;
  `NewTaskDraftScreen` records the thread before queueing it, and the outbox's launch carries the
  folder (kept in memory). The thread is also tagged once it shows up, for older servers
  and after a restart.
- Until a folder exists, Unfiled offers "Make a folder for each project" (confirmed).

Limits: the sidebar's project sort setting no longer applies here; the thread sort and "Visible
threads" count still do. The phone has no folder drag and drop; iOS keeps the flat list, so its
menu moves threads into folders it doesn't show (its new threads get the default folder too).
"Work locally" on a thread whose worktree setup failed starts a new thread that gets the default
folder, not the old thread's. Auto-filing has a few-millisecond window between its final check and
its tag writes in which a move made at that exact moment could lose to it. iOS wasn't tested; it
shares the phone's new-thread path, flat row and project settings screen.

Fork-owned files:

- Contracts: `packages/contracts/src/threadFolders.ts` (+ test; tag rules, the settings schema,
  the update input and `applyThreadFolderUpdate`, which the server and the clients' instant
  updates share).
- Server: `apps/server/src/threadFolders/ThreadFolderSettings.ts` (+ test; storage, seeding,
  retagging, `launchTags`), `ThreadAutoFile.ts` (+ test; eligibility, the folder choice, applying
  the answer; reads `thread-folders.json`, never writes it).
- Provider core: `packages/provider-core/src/server/threadFolderPrompt.ts` (+ test).
- Shared client rules (tag helpers, name checks, grouping, ordering, the merged view, the
  migration step, the folder-per-project plan, the new-thread project):
  `packages/client-runtime/src/threadFolders.ts` (+ test), exported as
  `@t3tools/client-runtime/thread-folders`; the server subscription, writes and instant updates:
  `packages/client-runtime/src/state/threadFolderSettings.ts`
  (`@t3tools/client-runtime/state/thread-folder-settings`). Hermes has no `Array#toSorted`, so
  keep it out of these files.
- Web: `apps/web/src/components/legacySidebarFolders.logic.ts` (+ test; only the row windowing,
  `resolveGroupPanel`), `legacySidebarFolders.store.ts` (the folder atoms, actions, tag writes,
  draft folders, per-folder thread atoms), `LegacySidebarFolders.tsx` (dialogs, menus, the default
  mark, palette items, the host that migrates the saved list and files sent drafts).
- Mobile: `apps/mobile/src/features/threads/threadFolderActions.ts` (folder atoms and actions, tag
  writes, prompts, draft filing, the row menu), `threadFolderListItems.ts` (the tree's list
  items), `thread-folder-tree.tsx` (grouping, headers and actions for both lists),
  `use-thread-folders.ts` (view state and the migration), `FolderArrangementSheet.tsx` (a
  `LegendList`, as upstream's `ThreadArrangementSheet`, since FlatList is a restricted import),
  `projectThreadTree.ts` (+ test; `buildFolderThreadTreeListItems`),
  `project-thread-tree-items.tsx` (`ThreadFolderHeader`),
  `apps/mobile/src/persistence/thread-folder-preferences.ts`,
  `apps/mobile/src/state/draftLaunchFolder.ts`.

Touch points:

- `packages/contracts/src/rpc.ts`: `threadFoldersSubscribe` / `threadFoldersUpdate`, their
  `Rpc.make` definitions and `WsRpcGroup` entries. `server.ts`: `threadFolders` in `ServerConfig`.
  `orchestrationV2.ts`: `folder` on `OrchestrationV2ThreadLaunchInput`, `tags` on the
  `thread.create` command. `clientRpcPermissions.ts`: operate scope for the update. `index.ts`:
  the export.
- `apps/server/src/ws.ts`: the import, `threadFolders` beside `voiceDictation`, the two handlers
  after the voice ones, `threadFolders: true` in the config, and in the `launchThread` handler
  `Effect.andThen(threadFolders.launchTags(input.folder))` plus the `tags` spread.
  `server.ts`: `ThreadFolderSettings.layer` after `VoiceDictation.layer`. `RpcAuthorization.ts`
  (read scope for the stream) and `RpcInstrumentation.ts`. `ws.test.ts`: the mock layer.
- `apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts`: `ThreadAutoFile.optional`
  (no requirement, so layers without it never auto-file), `folderChoice` before the initial title
  call, `folder` in `TitleOutcome`, `finish` after `complete`. `runtimeLayer.ts`: provides
  `ThreadAutoFile.layer` to the title service.
- Provider core (upstream files): `textGeneration.ts` (`folderChoice` input, `folder` result),
  `textGenerationPrompts.ts` (`folderChoice` on `ThreadTitlePromptInput`; `buildThreadTitlePrompt`
  appends the section and the `folder` key only with a choice), `textGenerationOperations.ts` and
  `provider-muse/src/server/textGeneration.ts` (pass the choice, return `threadFolderAnswer`),
  `package.json` (export).
- `apps/server/src/orchestration-v2/ThreadLaunchService.ts`: `tags` on `ThreadLaunchInput`,
  passed to `thread.create`. `Orchestrator.ts`: `dispatchThreadCreate` stores the command's tags
  (`runtimeLayer.test.ts`, the lifecycle test, covers it).
- `packages/client-runtime/src/operations/commands.ts`: `folder` on the bootstrap's `createThread`,
  sent as the launch's `folder` (+ `commands.test.ts`). `src/rpc/client.ts`: the subscription tag.
  `package.json`: the two exports.
- Web: `apps/web/src/components/LegacySidebar.tsx` (fork-owned, F1): `SidebarFolderItem`
  (`legacyFolderHeaderMenu`, `DefaultFolderMark`), `SidebarFolderThreadList`,
  `useLegacySidebarThreads` (groups, collapse and traversal keys through `resolveGroupPanel`),
  draggable `SidebarThreadRow`, `SortableFolderItem`, `UnfiledDropTarget`, the thread
  `DragOverlay`, `startThreadInFolder`. `LegacySidebarWorkers.tsx` and
  `legacySidebarWorkers.logic.ts` (F18): workers grouped with `groupWorkers` by folder, folder
  collapse from the server, `legacyThreadFolderMenu` in the worker thread menu.
  `CommandPalette.tsx`: one line pushing `legacyFolderPaletteItems(...)`, and
  `readNewThreadProject()?.title` first in `activeProjectTitle`. `LegacySidebar.tsx` also has
  `AutoFiledMark` in `SidebarThreadRow`, `AutoFileMenuGroup` in `SidebarOptionsMenu`,
  `NewFolderButton` beside `NewWorkerButton`, and `readNewThreadProjectRef()` first in
  `startThreadInFolder`. `lib/chatThreadActions.ts` (`startNewThreadFromContext`) and
  `routes/_chat.index.tsx` (landing draft): one new-thread-project line each.
  `settings/ProjectSettingsPanel.tsx`: `<NewThreadProjectSettingsRow …/>`, preferring upstream's
  `filePickerProject` (a checkout whose server is connected).
  `AppSidebarLayout.tsx`: mounts `LegacySidebarFoldersHost` beside the sidebar when
  `isElectron || forceLegacySidebar`. `chat/useComposerSend.ts` and `chat/useMultipleModelSend.ts`:
  `...draftLaunchFolder(draftId)` in the bootstrap's `createThread`.
- Mobile: `features/home/HomeScreen.tsx` and `threads/ThreadNavigationSidebar.tsx`:
  `useThreadFolderTree(...)`, `folderTree.groupListItems(...)` in place of the project grouping,
  `folderTree.renderItem(...)` for the folder items and `folderTree.arrangementSheet`;
  `onNewThreadInProject` takes an optional `requestId`. `home/HomeRouteScreen.tsx` and
  `layout/workspace/WorkspaceThreadSidebar.tsx`: `onNewThreadInProject` uses the given
  `requestId`. `threads/NewTaskDraftScreen.tsx`: one `fileSentDraftInFolder(...)` call before the
  outbox queues the first message. `lib/projectThreadStartTurn.ts`: `folder` in the spec and the
  bootstrap. `state/threadOutboxDelivery.ts`: `...draftLaunchFolder(...)` in the start-turn spec.
  `threads/thread-list-v2-items.tsx`: `useThreadFolderMenu(thread)` in the row's menu items and
  event handler, `onOpenMenu={folderMenu.onOpen}`, and `AutoFiledMark` in the tree and flat rows.
  `components/ui/Menu.android.tsx`: calls `onOpenMenu` on a long-press open.
  `layout/AdaptiveWorkspaceLayout.tsx` (`handleStartNewTask`): `newThreadProjectDraft(requestId)`
  before `newTaskDestination`. `settings/SettingsProjectOverviewRouteScreen.tsx`:
  `<NewThreadProjectSection …/>`. `persistence/mobile-preferences.ts`: `Preferences extends
  ThreadFolderPreferences` and one `sanitizeThreadFolderPreferences(parsed)` spread.

Verify:

- `vp test run packages/contracts/src/threadFolders.test.ts apps/server/src/threadFolders/ThreadFolderSettings.test.ts`
- `vp test run apps/server/src/orchestration-v2/runtimeLayer.test.ts -t "applies lifecycle commands idempotently"`
- `vp test run packages/client-runtime/src/threadFolders.test.ts packages/client-runtime/src/operations/commands.test.ts apps/web/src/components/legacySidebarFolders.logic.test.ts apps/web/src/components/legacySidebarWorkers.logic.test.ts`
- `vp test run apps/mobile/src/features/threads/projectThreadTree.test.ts apps/mobile/src/features/threads/workerThreadGroup.test.ts`
- `vp test run apps/server/src/threadFolders/ThreadAutoFile.test.ts packages/provider-core/src/server/threadFolderPrompt.test.ts`
- `grep -n "ThreadAutoFile" apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts apps/server/src/orchestration-v2/runtimeLayer.ts`
  (hits in both), `grep -n "folderChoice\|threadFolderAnswer" packages/provider-core/src/server/textGenerationOperations.ts packages/provider-muse/src/server/textGeneration.ts packages/provider-core/src/server/textGenerationPrompts.ts`
  and `grep -n "readNewThreadProject\|newThreadProjectDraft" apps/web/src/lib/chatThreadActions.ts apps/web/src/components/CommandPalette.tsx apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx apps/mobile/src/features/assistant/useAssistantLaunch.ts`.
- `grep -ln "threadFoldersSubscribe" apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/observability/RpcInstrumentation.ts packages/contracts/src/rpc.ts packages/client-runtime/src/rpc/client.ts`
  (all five), `grep -n "launchTags\|threadFolders: true" apps/server/src/ws.ts` (two hits) and
  `grep -n "ThreadFolderSettings.layer" apps/server/src/server.ts`.
- `grep -n "draftLaunchFolder" apps/web/src/components/chat/useComposerSend.ts apps/web/src/components/chat/useMultipleModelSend.ts apps/mobile/src/state/threadOutboxDelivery.ts`
  (one call each), and `grep -n "command.tags" apps/server/src/orchestration-v2/Orchestrator.ts`.
- `grep -n "legacyFolderPaletteItems\|LegacySidebarFoldersHost" apps/web/src/components/CommandPalette.tsx apps/web/src/components/AppSidebarLayout.tsx`
  (two hits each), `grep -c "useThreadFolderTree\|folderTree\." apps/mobile/src/features/home/HomeScreen.tsx apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`
  (5 or more each), and `grep -n fileSentDraftInFolder apps/mobile/src/features/threads/NewTaskDraftScreen.tsx` (two hits).
- In the desktop app: make a folder, drag a thread onto it and back to Unfiled, reorder and
  collapse folders and see the same on the phone; set "New threads go here" on a folder and start
  a thread with the sidebar's new-thread shortcut (it lands there); start one with another
  folder's new-thread button (it lands in that folder); rename a folder that holds an archived
  thread and unarchive it (it comes back in the renamed folder).
- Turn on "New threads start here" for a project (desktop or phone project settings); ⌘N, a
  folder's and Unfiled's buttons, the phone's New thread button and the assistant all open drafts
  in it. Send a clearly job-related first message from Unfiled's button: within a few seconds of
  the title it moves to Jobs with the auto-filed mark, which goes away when its menu opens. A vague
  first message ("hey") stays in Unfiled; a folder's button keeps its folder.
- In the Android app: long-press a thread, Move to folder › New folder…, and see it under that
  folder (and in the desktop sidebar); make a folder from Workers' Unfiled button; long-press the folder header to rename, arrange, make it
  the default and delete it; start a thread from a folder's new-thread button and send it (it
  lands in the folder); open Workers and see workers under their folders.

### F21. Stay connected for a few minutes after leaving the Android app (mobile, Android only)

Added November 8, 2026.

What it does: when you switch from the app to another one, a quiet foreground service ("T3 Code
is staying connected", with a countdown, a Stop button, and tap to return) keeps the app running
and its connection open for N minutes, so switching back shows live threads at once. After N
minutes, on Stop, or when you come back, the service ends and the app sleeps as before. N is
under Settings → Environments → "Stay connected after leaving": Off, 1, 5 (default), 10 or 15
minutes. It is kept on the device only (Android SharedPreferences, read natively the moment the
app leaves). Each return is logged on the device (time away, whether the service covered it,
whether the socket survived, ms until the thread list was live, and JS timer ticks while away;
last 300 in `<documents>/keep-connected-returns.json`), and the setting shows a 7-day summary to
pick N from.

How it keeps JS running: React Native Android stops JS timers when the activity pauses unless a
headless JS task is active (`JavaTimerManager`). Socket messages would still arrive, but the
connection's probes, retries, timeouts and debounces wait on timers. So on leaving, the native
module starts the foreground service (type `dataSync`) and a headless JS task
(`T3ForkKeepConnected`) together, from Expo's `OnActivityEntersBackground` (Android still allows a
foreground-service start then), and ends both together. Returns the service covered count as an
`application-active-probe` wakeup, not `application-active-long`, so a live socket is probed
quickly rather than treated as suspect. The thread list and an open thread still resubscribe
from their cursor on return (upstream's rule for every app-active wakeup), which over a live
socket finishes well before the 4-second F15 status delay, so no banner shows. Browser and device
previews still pause in the background (`useAppForeground`); thread views never did.

Fork-owned files: `apps/mobile/modules/t3-fork-keep-connected` (`KeepConnected.kt` decides when
the window runs and owns the setting, `KeepConnectedService.kt`, `AwaySession.kt` + JVM test,
`T3ForkKeepConnectedModule.kt`), and `apps/mobile/src/features/keep-connected/`:
`keepConnectedLogic.ts` (+ test: return classification, log, observation and summary),
`keepConnectedNative.ts`, `keepConnectedTracking.ts` (the headless task, the return log and its
watcher) and `KeepConnectedSettings.tsx`.

Touch points:

- `apps/mobile/src/connection/platform.ts`: in `layerWakeups`, the app-active wakeup goes
  through `forkKeepConnectedWakeup(mobileApplicationActiveWakeup(...), backgroundedAtMs)`.
- `apps/mobile/src/Stack.tsx`: `useKeepConnectedTracking()` in `RootStackLayout`, after
  `useAssistantLaunch()`.
- `apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx`:
  `<KeepConnectedSettings />` after `<PullRequestRoutingSettings />`.

Verify:

- `vp test run apps/mobile/src/features/keep-connected`; after `expo prebuild`,
  `./gradlew :t3-fork-keep-connected:testDebugUnitTest` in `apps/mobile/android`.
- `grep -n "forkKeepConnectedWakeup" apps/mobile/src/connection/platform.ts` (import and call),
  `grep -n "useKeepConnectedTracking" apps/mobile/src/Stack.tsx` and
  `grep -n "KeepConnectedSettings" apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx`
  (two hits each). If upstream stops building wakeups in `platform.ts` or stops pausing JS timers
  in the background, move or drop the hook.
- After prebuild: `grep -n "KeepConnectedService\|FOREGROUND_SERVICE_DATA_SYNC" apps/mobile/android/app/build/intermediates/merged_manifests/release/*/AndroidManifest.xml`
  (or `aapt2 dump xmltree` on the APK).
- On a device or emulator: leave the app; `adb shell dumpsys activity services com.willsmanley.t3code`
  shows `KeepConnectedService` with `isForeground=true`, and the notification is there. Rename a
  thread from another client while away; coming back shows the new title with no "Syncing" or
  "Reconnecting". With the setting at 1 minute the service ends after a minute; with Off it never
  starts. The setting's summary counts each return.

### C1. Nightly build and release workflow (CI)

Fork-owned: `.github/workflows/custom-nightly-linux.yml` (`5bffb2ec49` through `f9bc6b8b22`,
17 CI commits).

What it does: builds and publishes the nightly release on GitHub Actions. Since 2026-10-30 the
nightly agent builds on Hostkey instead (`scripts/fork/nightly-release.sh`, the same steps run one
after another), because Actions was disabled for the fork on 2026-10-27. The daily schedule
(09:23 UTC) still builds `main` as a fallback when Actions is on and no release exists for its
commit. Both number a build past every earlier release and run, since the number is the APK's
version code.

- **sync**: records the fork commit, the current upstream main SHA, the date and the build
  number, and decides whether a scheduled run should skip.
- **build**: merges that upstream SHA only when started with `merge_upstream=true` (on a conflict
  it aborts the merge and builds the fork as it is). Builds desktop JS with auto-update on, the
  CLI single executable, the resource monitor and the matching SSH runtime archive (with a smoke
  test). Packages the Linux AppImage, writes SHA256SUMS, and publishes a GitHub prerelease only
  from `main`. The Hostkey script differs here since November 11, 2026: no Linux desktop app,
  desktop JS with auto-update off, and the signed macOS app instead (C5).
- **android**: same merge step. Preview variant, fork package and name, build-number version code,
  over-the-air updates off, optional Firebase config. Gradle arm64 release build, re-signed with
  `apksigner` and checked against the expected signer fingerprint.
- **publish-android**: adds the APK and its checksum to the same release.

Depends on these upstream files and scripts: `scripts/resolve-nightly-release.ts`,
`scripts/update-release-package-versions.ts`, `scripts/build-cli-archive.ts`
(`--resource-monitor-dir`), `scripts/smoke-cli-archive.ts`, `scripts/build-desktop-artifact.ts`
(the `T3CODE_DESKTOP_*` variables), `apps/server/scripts/cli.ts build-exe`, `native/resource-monitor`,
root `build:desktop`, desktop `ensure:electron`, `packageManager` in `package.json`, and Expo
prebuild in `apps/mobile`.

Repository secrets it uses (names only): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and the optional `ANDROID_GOOGLE_SERVICES_JSON`. The Hostkey script reads the
same values from Bitwarden and the local Firebase config file (see its header).

When a step changes in the workflow, change it in `scripts/fork/nightly-release.sh` too.

Guess: the top-level `UPDATE_REPOSITORY` variable looks unused. Only the build job's
`T3CODE_DESKTOP_UPDATE_REPOSITORY` is read.

Verify:

- `for f in scripts/resolve-nightly-release.ts scripts/update-release-package-versions.ts scripts/build-cli-archive.ts scripts/smoke-cli-archive.ts scripts/build-desktop-artifact.ts apps/server/scripts/cli.ts native/resource-monitor/Cargo.toml; do test -e "$f" || echo "MISSING $f"; done`
- `grep -n "resource-monitor-dir" scripts/build-cli-archive.ts; grep -n "T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR" scripts/build-desktop-artifact.ts`
- A test build without publishing: `ctx-build-governor exec -- scripts/fork/nightly-release.sh --ref <commit> --no-publish`,
  or on Actions `gh workflow run custom-nightly-linux.yml -R willsmanley/t3-code --ref <branch> -f merge_upstream=false`.

### C2. Desktop auto-update from the fork's releases (desktop)

Commits `5bffb2ec49`, `1db45ac0c2`.

What it does: fork desktop builds download updates in the background and install them on quit,
from the fork's GitHub releases.

Touch points:

- `apps/desktop/src/app/DesktopConfig.ts`: `autoUpdate`, from `T3CODE_AUTO_UPDATE` or the
  build-time `__T3CODE_AUTO_UPDATE__`.
- `apps/desktop/vite.config.ts`: defines `__T3CODE_AUTO_UPDATE__` and `__T3CODE_RELEASE_BASE_URL__`.
- `apps/desktop/src/updates/DesktopUpdates.ts`: `setAutoDownload(config.autoUpdate)` and
  `setAutoInstallOnAppQuit(config.autoUpdate)`. Pending upstream commits touch this file.
- Update repository: upstream already reads `T3CODE_DESKTOP_UPDATE_REPOSITORY`
  (`scripts/build-desktop-artifact.ts`, `apps/web/vite.config.ts`). The workflow sets it to the fork.

Verify:

- `grep -n "setAutoDownload(config.autoUpdate)" apps/desktop/src/updates/DesktopUpdates.ts`
- `grep -n "__T3CODE_AUTO_UPDATE__" apps/desktop/vite.config.ts apps/desktop/src/app/DesktopConfig.ts`
- `grep -n "T3CODE_DESKTOP_UPDATE_REPOSITORY" scripts/build-desktop-artifact.ts`

### C3. SSH environments download the runtime from the fork's releases (desktop)

Commit `0f7de6350a` (its SSH part).

What it does: when the desktop sets up an SSH environment, it downloads the T3 runtime that
matches its own version from the fork's releases. The nightly publishes that runtime.

Touch points:

- `apps/desktop/src/app/DesktopConfig.ts`: `releaseBaseUrl` (`T3CODE_RELEASE_BASE_URL` or the
  build default).
- `apps/desktop/src/app/DesktopEnvironment.ts`: the `releaseBaseUrl` field (+ `DesktopEnvironment.test.ts`).
- `apps/desktop/src/main.ts`: `resolveDesktopSshCliRunner` passes `releaseBaseUrl`.
- `packages/ssh/src/tunnel.test.ts`: test only. Upstream's `buildRemoteT3RunnerScript` already
  accepts `releaseBaseUrl`.

Verify: `vp test run apps/desktop/src/app/DesktopEnvironment.test.ts packages/ssh/src/tunnel.test.ts -t "release mirror|fork release"`.

### C4. The fork's own Android app identity (mobile build)

Commits `a9a09829f6`, `9b0daf037b`, `28d14f6f71`, `1d59be06ce`.

What it does: `apps/mobile/app.config.ts` reads `T3CODE_MOBILE_APP_NAME`,
`T3CODE_ANDROID_PACKAGE` and `T3CODE_ANDROID_VERSION_CODE`, so the fork's APK ("T3 Code Fork",
package `com.willsmanley.t3code`, set in the workflow) installs next to the store app and
upgrades in place. It also sets the permissions F8 and F11 need, and the direct-push extra for F6
(`T3CODE_ANDROID_DIRECT_PUSH`, `T3CODE_ANDROID_GOOGLE_SERVICES_FILE`).

Touch points: `apps/mobile/app.config.ts`; `scripts/lib/public-config.ts` (+ test).

Verify:

- `grep -n "T3CODE_ANDROID_PACKAGE\|T3CODE_MOBILE_APP_NAME\|T3CODE_ANDROID_VERSION_CODE\|androidDirectPush" apps/mobile/app.config.ts`
- `vp test run scripts/lib/public-config.test.ts`
- Guess at the exact command:
  `APP_VARIANT=preview T3CODE_ANDROID_PACKAGE=com.example.check pnpm --dir apps/mobile exec expo config --type public | grep com.example.check`.

### C5. Mac desktop app built on Linux, signed and notarized (desktop build)

Added November 6, 2026 (built on the Mac); built on Hostkey since November 11, 2026.

What it does: the nightly release carries the Apple Silicon desktop app
(`T3-Code-<version>-arm64.zip` and the updater manifest `nightly-mac.yml`), built on Hostkey by
`scripts/fork/mac-desktop-build-linux.sh` the way ctx builds its macOS release on Linux:

- Nothing is compiled except the Rust resource monitor, which `cargo zigbuild` builds for
  `aarch64-apple-darwin` against the ctx release factory's pinned macOS SDK. Electron and the
  native packages (node-pty, objc-js, keyring, Clerk passkeys, ...) ship macOS builds.
- `scripts/fork/mac-linux-tools/` has stand-ins for `sips` and `iconutil`, which the build calls to
  make the app icon.
- rcodesign signs every binary with the Developer ID certificate (hardened runtime; the upstream
  entitlements minus the passkey ones, which need T3's provisioning profile), notarizes and
  staples. The certificate and notary key come from Infisical, as for ctx. A stable signature
  means macOS keeps the keychain item and privacy permissions across updates.
- Desktop JS is built with auto-update off: the app offers new releases but the Mac and the
  Hostkey server should move to a new version together.
- The packaged app has no prepared server compile cache (it needs the macOS app to run), so the
  local server's first start is slower; the Mac uses the Hostkey server.

Touch points: fork-owned `scripts/fork/mac-desktop-build-linux.sh`, `scripts/fork/mac-linux-tools/`,
the macOS step in `scripts/fork/nightly-release.sh`, and one hook in `scripts/build-desktop-artifact.ts`
(`npmRebuild = false` for a macOS build on a non-Mac host, because node-gyp can't compile for macOS
there). `scripts/fork/mac-desktop-build.sh` still builds an unsigned app on the Mac itself as a
fallback.

Verify:

- `grep -n 'npmRebuild = false' scripts/build-desktop-artifact.ts` (two: Windows and the macOS hook)
- `scripts/fork/mac-desktop-build-linux.sh <version> /tmp/mac-check --unsigned` after
  `pnpm install` and `vp run build:desktop`; the zip should hold `T3 Code (Nightly).app`.

### Already upstream or lost (no fork diff left)

- Follow-ups steer the running turn by default (`c2d2a543ff`): upstream did the same in #24718. Drop it.
- Scheduler hints in `packages/provider-core/src/server/orchestrationInstructions.ts`: overwritten
  by upstream's rewrite (`5f64c5eb29`). The MCP tool descriptions still cover them.

## 2. Overlap hotspots

Risk = fork lines changed in the file (added + removed, `git diff d1f701849b ea7c8bf901`) × upstream
commits that touched it in the 30 days since 2026-09-26 (`git log --since=2026-09-26 origin/main --name-only`).
"Pending" = upstream commits on the file not yet merged when this was measured.

| #   | Upstream file                                                               | Fork +/−       | Upstream commits (30 d) | Risk  | Feature    | Pending |
| --- | --------------------------------------------------------------------------- | -------------- | ----------------------- | ----- | ---------- | ------- |
| 1   | apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx     | +332/−36 (368) | 18                      | 6,624 | F4         | 1       |
| 2   | apps/server/src/scheduledTasks/ScheduledTaskService.ts                      | +200/−42 (242) | 23                      | 5,566 | F4         | 0       |
| 3   | apps/web/src/components/settings/ScheduledTasksSettings.tsx                 | +236/−17 (253) | 21                      | 5,313 | F4         | 0       |
| 4   | apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx                | +109/−21 (130) | 31                      | 4,030 | F7, F9     | 3       |
| 5   | apps/web/src/components/LegacySidebar.tsx (fork-owned, deleted upstream)    | +67/−79 (146)  | 27                      | 3,942 | F1, F2, F3 | 2       |
| 6   | apps/mobile/src/features/home/HomeScreen.tsx                                | +100/−6 (106)  | 31                      | 3,286 | F7, F9     | 2       |
| 7   | apps/server/src/relay/AgentAwarenessRelay.test.ts (test)                    | +114/−3 (117)  | 24                      | 2,808 | F6         | 0       |
| 8   | apps/mobile/src/features/threads/thread-list-v2-items.tsx                   | +93/−1 (94)    | 28                      | 2,632 | F7, F9     | 3       |
| 9   | apps/server/src/scheduledTasks/ScheduledTaskService.schedule.test.ts (test) | +288/−1 (289)  | 9                       | 2,601 | F4         | 0       |
| 10  | apps/server/src/ws.ts                                                       | +21/−0 (21)    | 103                     | 2,163 | F6         | 0       |
| 11  | apps/server/src/server.ts                                                   | +28/−4 (32)    | 66                      | 2,112 | F5, F6     | 0       |
| 12  | packages/contracts/src/scheduledTask.ts                                     | +141/−2 (143)  | 12                      | 1,716 | F4         | 0       |
| 13  | apps/server/src/relay/AgentAwarenessRelay.ts                                | +77/−37 (114)  | 15                      | 1,710 | F6         | 1       |
| 14  | apps/mobile/src/features/agent-awareness/remoteRegistration.ts              | +251/−24 (275) | 6                       | 1,650 | F6         | 0       |
| 15  | apps/server/src/mcp/OrchestratorMcpService.test.ts (test)                   | +49/−0 (49)    | 30                      | 1,470 | F4         | 0       |
| 16  | apps/server/src/scheduledTasks/Schedule.ts                                  | +188/−9 (197)  | 7                       | 1,379 | F4         | 0       |
| 17  | packages/contracts/src/rpc.ts                                               | +30/−0 (30)    | 39                      | 1,170 | F6         | 0       |
| 18  | apps/mobile/src/features/threads/threadListV2.ts                            | +60/−2 (62)    | 16                      | 992   | F7         | 0       |
| 19  | apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts (test)  | +54/−0 (54)    | 17                      | 918   | F4         | 1       |
| 20  | apps/server/src/git/GitManager.test.ts (test)                               | +17/−0 (17)    | 49                      | 833   | F5         | 0       |

Next in line: `scheduledTasksSettings.logic.ts` (756), `scheduledTaskDraft.test.ts` (747),
`scheduledTasksSettings.logic.test.ts` (712), `Schedule.test.ts` (645), `Sidebar.tsx` (640),
`packages/shared/package.json` (640).

Small fork edits in very busy upstream files. They're cheap now, but each is a place where
upstream adds lines next to the fork's (upstream commits in 30 days): `ws.ts` 103, `server.ts` 66,
`web Sidebar.tsx` 64, `ThreadDetailScreen.tsx` 61, `contracts/settings.ts` 54,
`OrchestratorMcpService.ts` 52, `mobile Stack.tsx` 41, `orchestrator tools.ts` 41,
`packages/shared/package.json` 40, `contracts/rpc.ts` 39, `RpcAuthorization.ts` 39,
`GitManager.ts` 39, `ThreadComposer.tsx` 37, `NewTaskDraftScreen.tsx` 36, `ThreadRouteScreen.tsx` 35,
`packages/client-runtime/package.json` 35.

## 3. Isolation plan

The goal for each item: fork logic in a fork-owned file, and only an import plus a call or prop
left in the upstream file. Order is by risk, with related items grouped. "Guess" marks ideas that
need a quick try before you rely on them.

1. **Thread tree in `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` (#4 and #6, 31
   upstream commits each).** F20 moved the grouping, header JSX and arrangement sheet into
   `useThreadFolderTree` (`thread-folder-tree.tsx`). What is left is the tree's overrides of the
   `useThreadListV2` inputs (`settledLimit`, working shelf off, shelves open) and the
   `showOlderSettledRow` rule; a `threadTreeListInputs(input)` helper there would leave each file
   with the import, the hook call, one `renderItem` line, `layout={rowLayout}` and
   `{folderTree.arrangementSheet}`.

2. **`thread-list-v2-items.tsx` (#8) and `threadListV2.ts` (#18).**
   - Move `treeContent` and its `RowPressable` wrapper into `ProjectThreadTreeRow` in
     `project-thread-tree-items.tsx`. `ThreadListV2Row` keeps one branch:
     `props.layout === "tree" ? <ProjectThreadTreeRow ... /> : ...`.
   - Move `FORK_CONVERSATION_MENU_ACTION` into `home/thread-fork.ts`.
   - Done in F20: the tree's list items and their equality live in `threadFolderListItems.ts`;
     `threadListV2.ts` keeps one union member and one delegating `case` group.

   About 8 lines are left in each file.

3. **Mobile scheduled-task screen (#1, 368 lines).** Add
   `apps/mobile/src/features/settings/ScheduledTaskTimingFields.tsx` holding `describeCadence`,
   `formatDateTime`, `stoppedLabel`, `DateTimePickerRow`, `TimeOfDayRow`, `InstantRows`, plus
   section components `<TimeZoneRow>`, `<ActiveHoursRows>`, `<OnceRows>` and `<EndRows>` that take
   `{ draft, setDraft }`. `TaskForm` keeps one element per section and the "Once" choice in the
   mode picker. About 10 lines are left.

4. **Web `ScheduledTasksSettings.tsx` (#3, 253 lines).**
   - Add `apps/web/src/components/settings/ScheduledTaskTimingFields.tsx` with `TimeZoneOptions`,
     `TimeZoneField`, `ActiveHoursField`, `OnceAtField`, `ScheduleEndFields`,
     `ScheduledStoppedLabel`, `onceLabel` and `withScheduleEnds`.
   - `ThreadAutomationsPanel.tsx` imports `ScheduledStoppedLabel` from the new file.
   - Upstream's `scheduleLabel` body stays, with two hook lines:
     `if (schedule.type === "once") return onceLabel(schedule);` and
     `return withScheduleEnds(schedule, label);`.

   About 15 lines are left: draft defaults, the mode toggle, one element per section.

5. **`ScheduledTaskService.ts` (#2, 242 lines). Partial isolation only.**
   - (a) Move `MAX_DATE_MS`, `nextRunTime`, `RunState`, `nextRunState` and `endedMessage` into a
     new `apps/server/src/scheduledTasks/ScheduleRunState.ts`.
   - (b) Move `endExpiredWebhookTasks` into `ScheduledTaskEnds.ts` as
     `makeEndExpiredWebhookTasks({ sql, decodeRow, notifyChanged })`. The service calls it once,
     in `runDueTasks`.
   - (c) Guess: replace the five `enabled = CASE WHEN ... THEN 0` edits inside upstream `UPDATE`s
     with one fork helper, `switchOffEndedTask(taskId, now)`, called after each write, so
     upstream's SQL stays byte-for-byte the same. Keep the run-count change (the `counted`
     pre-query); it's real logic, not wiring.

   Do (a) and (b) now. Do (c) only if this file conflicts. About 40 lines (upsert validation,
   active-hours deferral) will remain whatever you do.

6. **`LegacySidebar.tsx` (#5).** Upstream deleted the file; the fork keeps its own copy (F1), so it
   no longer conflicts. It breaks only when an API it uses changes.

7. **`AgentAwarenessRelay.test.ts` (#7) and `AgentAwarenessRelay.ts` (#13).**
   - (a) Let `AgentAwarenessRelay` get DirectPush through `Effect.serviceOption(DirectPush.DirectPush)`,
     treating none as disabled, or export a `DirectPush.layerDisabled`. Then upstream tests and
     `ws.test.ts` need no DirectPush mock, and new upstream harnesses don't break.
   - (b) Move the four direct-push tests into `AgentAwarenessRelay.directPush.test.ts`. Either
     copy the `makeTestRelay` helper or move it into a fork-owned `AgentAwarenessRelay.testkit.ts`.
   - (c) The publish-path changes in `AgentAwarenessRelay.ts` (nullable `relayConfig`, publishing
     to both targets) don't lift out cleanly. Leave them until they conflict. Then try a fork
     `publishTargets` helper that `publishState` calls.

8. **Fork tests appended to upstream test files (#9, #15, #19, #20 and smaller ones).**
   - Move the 289 fork lines in `ScheduledTaskService.schedule.test.ts` to
     `ScheduledTaskService.ends.test.ts`, and the webhook-end tests to
     `ScheduledTaskService.webhookEnds.test.ts`. This matches the existing
     `ScheduledTaskService.<topic>.test.ts` naming. Copy the roughly 15-line layer setup, or move
     it into a fork-owned `scheduledTasks/testkit.ts`.
   - Do the same for `OrchestratorMcpService.test.ts` (one test) and `shell-sync.test.ts`
     (one test) if their helpers can be imported.
   - Guess: the tests in `GitManager.test.ts` and `storageCleanup.test.ts` sit inside large
     `it.layer` blocks with in-file layers, so moving them may cost more than it saves.

9. **`ws.ts` (#10, 21 lines, the busiest file at 103 upstream commits).** Add
   `apps/server/src/notifications/DirectPushRpc.ts` exporting
   `directPushRpcHandlers(directPush, sessionId)`, which returns the two handlers with their error
   mapping. `ws.ts` keeps one import, `const directPush = yield* DirectPush.DirectPush`, and
   `...directPushRpcHandlers(directPush, currentSessionId)` in the handler object. The contracts
   error import goes away.

10. **`server.ts` (#11, 32 lines).**
    - (a) Add `apps/server/src/notifications/layer.ts` exporting `layerDirectPushLive`
      (DirectPush + DirectPushDevices + FcmClient + FetchHttpClient). `server.ts` becomes
      `AgentAwarenessRelay.layer.pipe(Layer.provideMerge(layerDirectPushLive))`: one line, and
      three imports become one.
    - (b) Keep the three `Layer.provide(layerServerSettings)` lines for F5. Each is one line. The
      alternative, reading the setting with `Effect.serviceOption` inside each method, could make
      the switch silently do nothing if the service is missing.

11. **`contracts/scheduledTask.ts` (#12, 143 lines).** Move the new schema pieces (time zone,
    instant, run limit, end fields, active hours, once) and `isValidTimeZone` /
    `isAbsoluteDateTime` into `packages/contracts/src/scheduledTaskTiming.ts`. `scheduledTask.ts`
    imports them and keeps only the spreads and union members inside upstream's structs (about
    12 lines). Re-export the two helpers so callers don't change.

12. **`contracts/rpc.ts`, `RpcAuthorization.ts`, `RpcInstrumentation.ts` (#17; 39, 39 and 23
    upstream commits).** Add `packages/contracts/src/directPushRpc.ts` with
    `DIRECT_PUSH_WS_METHODS` and the two `Rpc.make` definitions as an exported array. Then:
    - `rpc.ts`: `...DIRECT_PUSH_WS_METHODS` in `WS_METHODS`, and `...DirectPushRpcs` in
      `RpcGroup.make(...)`.
    - `RpcAuthorization.ts`: `...DIRECT_PUSH_RPC_SCOPES`.
    - `RpcInstrumentation.ts`: `...DIRECT_PUSH_RPC_AGGREGATES`.

    Both maps use `satisfies Record<WsRpcMethod, ...>`, so spreads still type-check. Guess: check
    that `RpcGroup.make` keeps its types with a spread array.

Not worth isolating now:

- **`remoteRegistration.ts`** (275 lines, but only 6 upstream commits in 30 days and none
  pending). Moving `registerDeviceWithDirectPush`, `forgetAgentAwarenessDirectPushEnvironment` and
  `setAgentAwarenessDirectPushTarget` out would mean exporting module-private state: the
  generation counter, the status setter, `registrationSignature`. Revisit if it conflicts.
- **`Schedule.ts`** (197 lines, 7 upstream commits): mostly added functions in a quiet file.
- **One-line registry and config edits**: `contracts/settings.ts`, `environment.ts`, `index.ts`,
  `serverSettings.ts`, the package.json export maps, `AppBar.types.ts`, `RelativeTime.tsx`,
  `ThreadStatusIndicators.tsx`, and the desktop config files. They're already thin hooks.
- **Photo prop threading through `ThreadRouteScreen`, `ThreadDetailScreen`, `ThreadComposer` and
  `NewTaskDraftScreen`** (1–3 lines each, in busy files). Already thin. Guess at an alternative:
  let `onPickDraftMedia(source?: "library" | "camera")` cover the camera so no new prop is passed
  through, at the cost of hiding the parameter from the in-between prop types. Only worth it if
  these lines keep conflicting.
- **`docs/user/*.md`**: fork docs belong in the user docs, and doc conflicts are easy to resolve.
- **The moved relay helpers** (`infra/relay` → `packages/shared`): 2 upstream commits each in 30
  days. If upstream edits an old path, port the change by hand (see the F6 check).

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
  `AgentAwarenessRelay` need `DirectPush`. So any new upstream test or harness that builds those
  layers will fail to typecheck until it gets `ServerSettings.layerTest()` or a `DirectPush` mock.
- **The agent context budget.** `AgentContextBudget.test.ts` compares the measured size of the
  MCP tool list and agent instructions with `apps/server/src/provider/agentContextBudget.json`
  exactly. The fork's scheduling fields make the tool list larger, so after each merge set the
  file to the values the test reports, and keep fork tool text short.
- **Renamed upstream symbols.** `isMissedFixedTimeRun` became `isMissedRun` (Schedule.ts) and
  `webhookDraftErrors` became `scheduleDraftErrors` (web scheduler logic). Renames turn upstream
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
always use the project-tree ("legacy") sidebar, with projects in manual order. The sidebar is also
lighter: no project favicons, no remote-environment icons or labels, a small status dot in a fixed
column left of the title, and short timestamps like "5m". Elsewhere upstream's sidebars apply,
including the Labs "boring sidebar".

Fork-owned files: `apps/web/src/components/LegacySidebar.tsx` (upstream's last copy plus the fork's
changes), `apps/web/src/components/LegacySidebar.logic.ts` (helpers upstream removed from
`Sidebar.logic.ts`).

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
  compact` in a left column, `<RelativeTime compact>`, `sidebarProjectSortOrder` forced to
  `"manual"` on Electron.

When upstream changes an API the file uses, fix the file; don't merge upstream's sidebar into it.

Verify (no tests cover the look):

- `grep -n "isElectron || forceLegacySidebar" apps/web/src/components/AppSidebarLayout.tsx apps/web/src/shortcuts/chatRouteCommands.ts` (one hit each).
- `grep -n 'isElectron ? "manual"' apps/web/src/components/LegacySidebar.tsx` (one hit).
- `grep -n "ProjectFavicon\|EnvironmentMachineIcon" apps/web/src/components/LegacySidebar.tsx` (no hits).
- Look at the desktop nightly: project tree, small dots, compact times.

### F2. Snooze threads from the project sidebar (web/desktop)

Commit `83c5b5df96`.

What it does: the project sidebar's thread menu and multi-select menu can snooze and unsnooze.
Snoozed threads leave their project and appear in a "Snoozed" section at the bottom.

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
  (12 today; fewer means a hook was dropped).

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

### F4. Scheduler: time zones, active hours, one-off tasks, tasks that end themselves

Commits `7b635bccae`, `c4674d8d70`, `6e4956e624`, `15ef0c5a16`, `26bc3b2dc5`, `229aaaec8d`.

What it does: a scheduled task can (a) run a fixed-time schedule in a chosen IANA time zone,
(b) limit an interval task to active hours, (c) run once at a set time, and (d) stop after N runs
or at an end time. A task that ends stays listed but switched off, labeled Done, Missed or Ended.
All of this works in web settings, mobile settings and the agent MCP tools
(`schedule_task`, which also updates a task given `scheduledTaskId`).

Fork-owned files: `packages/client-runtime/src/scheduledTaskSchedule.ts` (+ test), the draft
helpers shared by web and mobile.

Touch points:

- `packages/contracts/src/scheduledTask.ts`: new schema pieces (`timeZone`, `activeHours`,
  `once`, `endAfterRuns` / `endAt`), the validators `isValidTimeZone` and `isAbsoluteDateTime`,
  and a `once` member in both unions (+ `scheduledTask.test.ts`).
- `packages/contracts/src/orchestratorMcp.ts`: schedule description, and `runCount` on the MCP
  task summary.
- `apps/server/src/scheduledTasks/Schedule.ts`: `activeHoursDeferral`, `endsToStore`,
  `timerScheduleToStore`, `scheduleEnd`, time-zone-aware next run, and the rename of
  `isMissedFixedTimeRun` to `isMissedRun` (+ `Schedule.test.ts`).
- `apps/server/src/scheduledTasks/ScheduledTaskService.ts`: `nextRunState` / `endedMessage`
  replace `nextRunAt`. SQL updates switch ended tasks off (`enabled = CASE WHEN ... THEN 0`).
  `runDueTasks` calls `endExpiredWebhookTasks`, which also returns the next webhook end time so
  upstream's idle wake-up (only queries when a run is due) still switches webhooks off on time;
  it defers runs that fall outside active hours,
  validates one-off times on upsert, and applies webhook run limits
  (+ `ScheduledTaskService.schedule.test.ts`, `ScheduledTaskService.webhook.test.ts`).
- `apps/server/src/mcp/OrchestratorMcpService.ts`: `runCount` in the summary; a new `at` turns a
  finished one-off back on (+ test).
- `apps/server/src/mcp/toolkits/orchestrator/tools.ts`: the `schedule_task` description's
  time-zone, kept-on-update and one-off hints.
- `apps/server/src/provider/agentContextBudget.json`: `mcpToolListJsonBytes` is the fork's
  measured size (see "Merge hazards").
- `apps/web/src/components/settings/ScheduledTasksSettings.tsx`: Once mode, time zone field,
  active hours, "Stop after N runs / at" fields, `ScheduledStoppedLabel`, a richer
  `scheduleLabel`.
- `apps/web/src/components/settings/scheduledTasksSettings.logic.ts`: draft fields,
  `scheduleDraftErrors` (renamed from `webhookDraftErrors`), `localDateTimeInputValue` (+ test).
- `apps/web/src/components/chat/ThreadAutomationsPanel.tsx`: uses `ScheduledStoppedLabel`.
- `apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx`: the same fields on
  mobile (date-time pickers, labels).
- `apps/mobile/src/features/settings/scheduledTaskDraft.ts`: draft fields (+ test).
- `packages/client-runtime/package.json`: export `./scheduled-task-schedule`.
- `apps/server/scripts/migrate-dev-db.ts`: seeded dev databases also clear
  `scheduled_task_webhook_pending` and `scheduled_task_webhook_replay_keys`.
- `docs/user/project-settings.md`: user docs.

Verify:

- `vp test run packages/contracts/src/scheduledTask.test.ts packages/client-runtime/src/scheduledTaskSchedule.test.ts apps/server/src/scheduledTasks/Schedule.test.ts apps/server/src/scheduledTasks/ScheduledTaskService.schedule.test.ts apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts apps/mobile/src/features/settings/scheduledTaskDraft.test.ts`
- `vp test run apps/server/src/mcp/OrchestratorMcpService.test.ts -t "one-off"`
- `grep -n 'Toggle value="once"' apps/web/src/components/settings/ScheduledTasksSettings.tsx` (one hit).

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
  error message (+ test).
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
  (on its VcsDriverRegistry layer), `apps/server/scripts/evaluate-thread-titles.ts`.
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

### F7. Android thread list grouped by project (mobile, Android only)

Commits `a7e6c56c58`, `4a160a79eb`, `ad1ed9c813`, `dbeb30f38d`.

What it does: on Android, the home list and the tablet sidebar group threads under collapsible
project headers, like the desktop sidebar. Rows are one line: status icon, title, time. Each
project shows a few threads and a "show more" row. Each header has New thread, Move up / Move
down and Arrange (a sheet to reorder every project), and the app remembers the order. iOS keeps
upstream's flat list (`PROJECT_THREAD_TREE_ENABLED = Platform.OS === "android"`).

Fork-owned files: `apps/mobile/src/features/threads/projectThreadTree.ts` (+ test),
`project-thread-tree-items.tsx`, `use-project-thread-tree-state.ts`, `ProjectArrangementSheet.tsx`.

Touch points:

- `apps/mobile/src/features/home/HomeScreen.tsx`: imports; `useProjectThreadTreeState()`;
  overrides the `useThreadListV2` inputs when the tree is on (`settledLimit` infinite, shelves
  open, working shelf off); `buildProjectThreadTreeListItems(...)`; `useRememberProjectOrder`;
  renders the `v2-project` and `v2-project-more` items; `layout="tree"` on rows;
  `<ProjectArrangementSheet>`; "older settled" row logic.
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`: nearly the same block.
- `apps/mobile/src/features/threads/thread-list-v2-items.tsx`: a `layout?: "flat" | "tree"` prop
  and the one-line tree row JSX (`treeContent`).
- `apps/mobile/src/features/threads/threadListV2.ts`: `ThreadListV2ProjectHeaderListItem` and
  `ThreadListV2ProjectMoreListItem` in the union, `isThreadListV2ListItem`, equality cases.
- `apps/mobile/src/persistence/mobile-preferences.ts`: the `projectOrder` preference and its
  sanitizing.

Verify:

- `vp test run apps/mobile/src/features/threads/projectThreadTree.test.ts`
- `grep -c "PROJECT_THREAD_TREE_ENABLED" apps/mobile/src/features/home/HomeScreen.tsx apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` (6 or more each).
- `grep -n 'case "v2-project"' apps/mobile/src/features/threads/threadListV2.ts` (one hit).

### F8. Voice input on Android through ElevenLabs (mobile, Android only)

Commits `434db9cba7`, `28d14f6f71`.

What it does: Android gets voice input. It records AAC (ADTS) into document storage, so a crash
doesn't lose the file. A recording can run up to 20 minutes and keeps going in the background
behind a notification. It's transcribed with ElevenLabs speech-to-text, using an API key the user
saves under Settings → Microphone (kept in secure storage). Recordings are kept until
transcription succeeds, and the settings page lists them.

Fork-owned files: `apps/mobile/src/features/voice-input/elevenLabsTranscription.ts` (key and
upload), `savedRecordings.ts` (where the files live),
`apps/mobile/src/features/settings/VoiceTranscriptionSettings.tsx`, and
`apps/mobile/src/native/voiceTranscription.android.ts`. That last file is a platform override of
upstream's `voiceTranscription.ts`, so the Android build picks it up without any import change.
Everything else is shared with web and desktop (F14) in `packages/client-runtime/src/voice-input/`:
`elevenLabs.ts` (URL, model, retries, error messages, the transcriber and the retry from settings)
and `savedRecordings.ts` (keeping audio until its transcript is saved, listing, pruning), each with
a test.

Touch points:

- `apps/mobile/src/features/voice-input/VoiceInputProvider.tsx`: Android recording options and
  `RECORDING_LIMIT_SECONDS`; inside `voiceInputAtom`, the session's `recordingLimitSeconds`, the
  background-recording flag, `releaseRecording` instead of delete, no cancel on background while
  recording or while the microphone permission dialog is up (it pauses the app, so the first try
  would otherwise stop), and pruning saved transcripts once per launch.
- `apps/mobile/src/features/voice-input/voiceInputSession.ts`: the elapsed-time clamp uses
  `recordingLimitSeconds`, so the Android timer runs past five minutes.
- `apps/mobile/src/lib/audioSession.ts`: an `allowsBackgroundRecording` parameter.
- `packages/client-runtime/src/voice-input/controller.ts`: a `recordingLimitSeconds` dependency;
  passes `VoiceTranscriptionError` messages through (+ `controller.test.ts`).
- `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`: lists the Microphone page on
  Android too.
- `apps/mobile/src/features/settings/SettingsMicrophoneRouteScreen.tsx`: renders
  `<VoiceTranscriptionSettings>` on Android.
- `apps/mobile/app.config.ts`: expo-audio `recordAudioAndroid: true` and
  `enableBackgroundRecording: true`. expo-image-picker no longer sets
  `microphonePermission: false`, which blocked RECORD_AUDIO.

Verify:

- `vp test run packages/client-runtime/src/voice-input`
- `grep -n "export function getLocalVoiceTranscriber" apps/mobile/src/native/voiceTranscription*.ts`
  (expect `.ts`, `.ios.ts` and `.android.ts`). If upstream adds its own `voiceTranscription.android.ts`
  or renames the function, the override breaks.
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
- Depends on F3's `threadEnvironment.forkFromLatestStable` (client-runtime) and upstream's
  `waitForThreadShellReady`.

Verify:

- `vp test run apps/mobile/src/features/home/thread-fork.test.ts`
- `grep -n "FORK_CONVERSATION_MENU_ACTION" apps/mobile/src/features/threads/thread-list-v2-items.tsx` (two hits).

### F10. Archive a thread from its header menu (mobile)

Commit `ec99764996`.

What it does: the thread screen's header overflow menu has "Archive thread". It leaves the
thread right away, before the server answers.

Touch points:

- `apps/mobile/src/components/ui/AppBar.types.ts`: `overflowOnly` on `AppBarAction`. Upstream's
  Android header already honors it.
- `apps/mobile/src/features/threads/ThreadHeader.tsx`: the `onArchiveThread` prop and action.
- `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`: wires
  `useOpenThreadArchiveAction(useWorkspaceListNavigation("threads"))`, only when the thread can
  be changed, isn't being created and isn't archived.
- `apps/mobile/src/features/workspace/useAndroidWorkspaceNavigation.ts`: exports
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
in the build's assistant project, a fresh draft each time, already recording through the F8 voice
input (tap ✓ to drop the words into the draft, × to type instead). The nightly sets that project's folder
with `T3CODE_ASSISTANT_PROJECT_ROOT` (Wills's Personal project). With no folder set, or no
connected project at it, it opens Choose project instead. Android only needs an activity that
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
- `apps/mobile/src/Stack.tsx`: `useAssistantLaunch()` next to `useAppShortcuts(props.state)`.
- `apps/mobile/src/lib/appLinking.ts`: `shouldHandleAppLink` ignores the assist link, so the
  router doesn't open NotFound for it.
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

What it does: the composer gets a mic button beside send. It records with the browser's
`MediaRecorder` and transcribes with the same ElevenLabs Scribe call as Android (F8), through
upstream's shared `VoiceInputController`, so the transcript lands at the cursor with the same
draft checks as mobile. While it records or transcribes, the editor is read-only and send is off;
× cancels, ✓ transcribes. Recordings stop at 20 minutes, like Android. The API key is saved once
on the server, in its secret store as `<base-dir>/userdata/secrets/elevenlabs-api-key.bin` (mode
600). Each time the mic starts, the client asks the thread's server for it over the
`server.getElevenLabsApiKey` RPC (operate scope, which can already run commands there) and then
uploads straight to ElevenLabs, so no audio goes over the WebSocket. Nothing is pasted in a browser
or the desktop app; Android still keeps its own key (F8). Recordings are kept exactly as on
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

Verify:

- `vp test run packages/client-runtime/src/voice-input apps/server/src/voiceInput`
- `grep -c "voiceInputBusy" apps/web/src/components/chat/ChatComposer.tsx` (four),
  `grep -c "<ComposerVoiceInputControl" apps/web/src/components/chat/ChatComposer.tsx` (one) and
  `grep -c "<VoiceRecordingsSettingsSection" apps/web/src/components/settings/SettingsPanels.tsx` (one).
- `grep -ln "serverGetElevenLabsApiKey" apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/observability/RpcInstrumentation.ts packages/contracts/src/rpc.ts` (all four).
- If upstream ships its own web voice input, compare the two and drop this one.

### F15. Faster return to the Android app (client-runtime, mobile)

Added October 31, 2026.

What it does: coming back to the app after a while shows the saved thread list and messages at
once and catches up quietly.

- After more than 10 seconds in the background, the old connection gets one second to answer
  before it is replaced (upstream waits up to 3 seconds, or 2.5 seconds of silence on a remote
  route such as T3 Connect). A phone's socket is usually dead by then.
- With saved threads on screen, "Syncing threads...", "Reconnecting to ..." and "Syncing
  messages..." wait 4 seconds before they show (upstream: 0.8 and 0.4 seconds). Offline, errors and
  an empty list still show at once.

Fork-owned files: `apps/mobile/src/features/home/workspace-connection-status-delay.ts` (+ test).

Touch points:

- `packages/client-runtime/src/connection/supervisor.ts`: `LONG_RESUME_PROBE_TIMEOUT` and its use
  for `application-active-long` in `probeTimeoutFor` (+ two tests in `supervisor.test.ts`: one new,
  one changed from 2999 to 999 ms). This affects iOS as well.
- `apps/mobile/src/features/home/WorkspaceConnectionTitle.tsx`:
  `workspaceConnectionStatusShowDelayMs(state)` replaces `STATUS_SHOW_DELAY_MS`.
- `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`: `CATCH_UP_SHOW_DELAY_MS` as the third
  argument of the `threadSyncLabel` `useDelayedStatus` call.

Verify:

- `vp test run apps/mobile/src/features/home/workspace-connection-status-delay.test.ts packages/client-runtime/src/connection/supervisor.test.ts`
- `grep -n "LONG_RESUME_PROBE_TIMEOUT" packages/client-runtime/src/connection/supervisor.ts` (two hits),
  `grep -n "workspaceConnectionStatusShowDelayMs" apps/mobile/src/features/home/WorkspaceConnectionTitle.tsx`
  and `grep -n "CATCH_UP_SHOW_DELAY_MS" apps/mobile/src/features/threads/ThreadDetailScreen.tsx`.
- If upstream retunes the resume check, keep its structure and only shorten the long-resume wait.

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
  from `main`.
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

1. **Project tree in `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` (#4 and #6, 236 lines,
   31 upstream commits each, both pending).** The two files carry nearly the same block. Add
   `apps/mobile/src/features/threads/useProjectThreadTreeList.tsx` with:
   - `projectTreeListInputs(input)`, which applies the tree overrides (`settledLimit`, working
     shelf off, shelves open). The call becomes `useThreadListV2(projectTreeListInputs({...}))`.
   - `useProjectThreadTreeList({ flatItems, projectScopes, selectedThreadKey, hiddenSettledCount, olderSettledShelf, settledShelfExpanded, onNewThreadInProject, pane })`,
     returning `{ items, showOlderSettledRow, rowLayout, renderTreeItem, arrangementSheet }`. It
     holds `useProjectThreadTreeState`, `buildProjectThreadTreeListItems`,
     `useRememberProjectOrder`, the header and "more" row JSX, and the arrangement sheet.

   Each upstream file then keeps about six one-line hooks: the import, the hook call, one line in
   `renderItem` (`const tree = renderTreeItem(item); if (tree) return tree;`),
   `layout={rowLayout}`, `{arrangementSheet}`, and the `showOlderSettledRow` use. Guess: React
   Compiler rules may prefer a `<ProjectThreadTreeItem>` component to a render function.

2. **`thread-list-v2-items.tsx` (#8) and `threadListV2.ts` (#18).**
   - Move `treeContent` and its `RowPressable` wrapper into `ProjectThreadTreeRow` in
     `project-thread-tree-items.tsx`. `ThreadListV2Row` keeps one branch:
     `props.layout === "tree" ? <ProjectThreadTreeRow ... /> : ...`.
   - Move `FORK_CONVERSATION_MENU_ACTION` into `home/thread-fork.ts`.
   - Move the two list-item interfaces and their equality checks into `projectThreadTree.ts` and
     export `projectTreeListItemsAreEqual`. `threadListV2.ts` keeps the two union members and one
     delegating `case`.

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

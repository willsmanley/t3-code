# Native Agent Session Record export

T3 owns facts that its providers cannot faithfully record. A scheduled prompt, a delegated
result and a message from another thread all arrive at a coding agent as user input. Exporting
only that provider's transcript loses who actually wrote them. T3 also owns queues, steering,
approval routing, cross-provider delegation and git checkpoints.

This proposal adds an offline `AsrExport` service and a thin `t3 export-asr` command. It writes
[Agent Session Record (ASR) 0.1](https://agentsessionrecord.org), following the draft-v3.1 T3 registry
mapping. The implementation is a native snapshot exporter (adoption level L1). It adds no work
to running turns and no dependency on an ASR library at runtime. It is a proposal for maintainers
to assess before adding export controls to the clients.

## Use

```sh
t3 export-asr --all --output /tmp/t3-asr-out
t3 export-asr --thread '<native T3 thread ID>' --output /tmp/t3-thread-asr
```

The default source is `~/.t3/userdata`; `--userdata` selects a different existing directory.
Exactly one of `--all` and `--thread` is required. `--all` includes subagents and archived and
soft-deleted threads. From a source checkout, use the repository's supported Node version:

```sh
node apps/server/src/bin.ts export-asr --all --output /tmp/t3-asr-out
```

The destination must be new, outside the source directory, with an existing parent. It contains
`bundle.json` and one hashed-name `sessions/*.jsonl` file per thread. The manifest includes byte
SHA-256 digests, record counts and explicit missing entries for referenced sessions not included
in the export. Native Claude/Codex transcripts and attachment bytes are not opened or copied.
The command prints aggregate counts only. Errors identify the stage without echoing source data.

The directory is private (0700) and files are 0600. This is a private archive, not a sanitized
share artifact: ordinary conversations, command output, paths and attachment descriptors remain
sensitive. Secret-request answers are never selected or written; webhook secrets, headers and
bodies, credentials, auth sessions and settings are not queried. No server, migration, checkpoint
capture or provider process is started.

## Identity and authority

Each stream has `agent.name: t3-code`, the verbatim thread ID and the environment's persisted ID
as `namespace`. SessionRef escaping preserves IDs containing colons and percent signs. IDs from
different installations are never joined without the namespace.

`lineage.executedBy` references backing harness sessions. Historical destinations retained on
run attempts are included alongside current provider-thread references: recovery can reuse a
provider-thread row with a new native session ID. Per-attempt and provider-turn `state` records
carry the backing session; only Codex has a qualified native turn correspondence in this source
version. Historical attempt events use their retained destination, while current provider-turn
references stay in the snapshot tail. Other strong adapter references remain metadata.

A strong reference is not automatically an ASR identity. Pi stores a session file path rather
than its header ID, so those paths remain vendor metadata with a declared lineage loss. Claude
workflow members also have app-generated task keys; those keys are not emitted as Claude
session IDs. Positively identified Claude provider-native child transcripts are marked `mirror`.

Copies use session-level `copiedFrom` with `proof: native_field`. T3's source item points to its
provider session, but an adapter's item ID may not identify the same record in a native ASR
stream. In particular, `callId=` identifies a call, not its result. We avoid inventing exact
cross-stream record references. Consumers must choose either T3 usage aggregates or backing
session usage when totaling the same work.

## Mapping

| T3 fact                              | ASR representation                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Human prompt, queued input, steering | `message`, with author and origin from T3; exact typed text in `displayContent`; model-facing prompt absent because T3 wraps it          |
| Scheduled or webhook prompt          | Harness-authored injected message; run `trigger` from task ID and firing key                                                             |
| Wake notice or delegated result      | Harness injection or agent-authored `subagent_report`, respectively; task/event trigger where recorded                                   |
| Inter-thread message                 | Agent-authored `inter_session`, with `from.session` naming the sender thread                                                             |
| Runs and attempts                    | `state`, queue details, attempt number/reason, retained restart `continuationOf`; provider links as above                                |
| Assistant messages and tool items    | Message snapshots; tool call/result pairs, nested parent calls and native IDs; duplicate call IDs preserved and results marked ambiguous |
| Reasoning                            | A reasoning part with text and absent visibility; no guessed full/summary visibility                                                     |
| Approvals                            | `permission` revisions with decision, feedback and subject when available; missing resolver identity stays absent                        |
| Questions and secret requests        | `input_request`, questions, answer selections/text and attachment descriptors; secret cards contain status and prompt metadata only      |
| Delegated work                       | `subagent` revisions with child T3 session, executor harness, model and delivery metadata                                                |
| Checkpoints                          | `checkpoint`, `kind: git_ref`, hidden ref, status, run and file summaries; no git operations                                             |
| Pull requests                        | `vcs.pr_open` only for recorded creation; otherwise `pr_link`, with source and watch metadata                                            |
| Compaction                           | `compaction`, token counts, optional idle reason, `replaces: {state: unknown}`                                                           |
| File edits                           | Structured operations and available patch; unidentified operations or paths containing parent traversal stay vendor data                 |
| Usage, plans and background work     | One usage aggregate per T3 run; context-window snapshots, plans/goals and pending terminal metadata                                      |

The first emitted record for a run carries its trigger. Current schedule definitions can have
changed since a firing; their cadence is not backdated. If the task definition no longer exists,
the trigger retains its ID and uses a vendor scheduled-task kind rather than guessing webhook
versus timer.

Run usage sums retained provider-turn counters, with `coverage: partial` when components are
missing or incomplete. Each source component remains in vendor metadata. Missing optional
counters are never treated as known zero; a sum outside JavaScript's safe integer range is
omitted. Coverage stays partial because retained rows cannot prove complete run accounting. Provider turns without a T3 run use a vendor scope, not a fabricated session total.

## Snapshot consistency and order

`AsrSource` reads the event store and its transactional projections through a read-only SQLite
connection with `query_only=ON`. All threads share one read transaction. Export refuses stale
projection high-water marks, unsupported schema versions and malformed records. The database
snapshot is released before publishing the final manifest. A failure removes only the newly
created destination; existing destinations are never overwritten.

T3 compacts whole-entity events, so each export creates a new capture. Surviving audit events
are serialized first in native event sequence. All current projection rows follow with
`assembly.mode: snapshot`: turn items in persisted ordinal order, messages without items in
projection row order, then requests, subagents, checkpoints, runs, attempts, handoffs, provider
state, usage, PR links, session metadata and settings. No stores are merged by timestamp.
Historical requests omit current UI details; full current request cards follow in the tail.
A current settings record also has `snapshot: true`. Deduplicated subagent event prompts are
restored through their persisted anchor sequence.

Headers carry `observedAt` and declare `order` and `revision_history`. Record IDs derive from
stable T3 entity/item IDs or surviving event IDs, never export sequence positions. These IDs
survive compaction and content growth; `seq` is local to each capture. No record uses
`idScope: capture` because none relies solely on a replaceable source position. Record bytes
and digests can change between captures without establishing a source revision. Re-export
into a new directory; do not concatenate captures. The manifest selects one capture per session.

Audit-prefix positions are not context chronology. In particular, a rollback event whose
context predecessor cannot be established remains a vendor rollback fact, not a guessed rewind.

## What T3 needs to retain for exact export

1. Persist tool names for command, file and search items, plus exact model-facing input/output
   and an explicit truncation/capture marker. Current tool output is a display representation.
2. Persist reasoning visibility (`full`, `summary`, encrypted/redacted) and summary segments.
   Current text alone cannot distinguish full reasoning from a provider summary.
3. Persist the resolving actor and calling thread on request-resolution events. Opaque command
   receipts do not establish a human or parent-agent decider. The current MCP responder answers
   questions, not approvals.
4. Persist native user-turn/message IDs, native result IDs and transcript identity separately
   from adapter-generated IDs. Retain immutable backing session IDs on every attempt; old rows
   without them cannot always be joined after recovery.
5. Persist usage-limit and manual continuation targets on runs. They currently exist on dispatch
   commands but are not retained on the run snapshot; only restart continuation is exported.
6. Persist immutable creation positions and the event IDs needed for audit ordering, explicit
   context inheritance/transfer links, question blocking and answer-message links, and native
   session header IDs for providers that currently store locators.

The export declares these limitations rather than manufacturing data. It also declares missing
inference/cost detail, binary content, raw protocol frames and unmapped metadata. Handoff source
item lists are preserved in vendor metadata; exact `derivedFrom` references are not asserted
without an item-to-native-message join. Malformed or unsupported input fails explicitly rather
than producing a silently partial archive.

## Extension and validation

`codes.t3/export` version 1 is optional: core records can be understood without it. Registry
`codes.t3/*` metadata retains dispatch, request, subagent, checkpoint, PR, inbox and cache facts.
Additional keys describe source references, snapshot ordering, usage components and opaque
resolution command IDs. Vendor records preserve provider-session lifecycle, runtime requests
without representable schemas, file edits, rollback requests and thread creation. Vendor enum
values are explicit mappings, not a prefix applied to arbitrary native strings. `allow_session`
is used for both the decision and option kind. The defined `_codes.t3/cancelled` option means
T3's native `cancel` choice. `_codes.t3/preparing`, `starting`, `pending` and `superseded` execution
states preserve workspace preparation, provider startup, pending attempts and superseded
attempts, respectively. Unmapped optional subagent statuses stay in `codes.t3/subagent.status`;
setup-hook statuses without a core equivalent use `unknown` and `codes.t3/hookStatus`.

`codes.t3/provider_identity` snapshots keep the verbatim `codes.t3/nativeThreadRef` object.
`codes.t3/nativeTaskRef` stays on subagents; `codes.t3/nativeTurnRef` stays on current execution
snapshots. Usage components use the registry's `codes.t3/providerUsage` array of
`{providerTurnId, turnTokenUsage}`. Original permission choices and decisions remain in
`codes.t3/permissionOptions` and `codes.t3/permissionDecision`. Historical question events whose
UI schema is no longer retained embed the native request, while current cards normalize answers.

Unsafe integer tool arguments are preserved as whole JSON text in `inputText`, with `input`
absent. Other unsafe numeric source fields fail the export explicitly instead of being rounded;
the exporter cannot invent an ASR numeric value or silently discard the source fact.

Synthetic SQLite fixtures exercise the real service and filesystem adapter, source immutability,
private output, bundle digests, provenance, superseding approvals/subagents, secret exclusion,
ordering after compaction, recovery, partial usage and duplicate calls. Run:

```sh
vp test run apps/server/src/asr/AsrExport.test.ts
ASR_VALIDATOR=/path/to/agent-session-record/tools/validator/bin/asr-validate.js \
  vp test run apps/server/src/asr/AsrExport.test.ts
```

With `ASR_VALIDATOR`, every inspected synthetic bundle also runs the reference validator. It
reports the optional extension as unsupported; this is not a schema or semantic error. Schema
validation does not prove source fidelity, privacy or universal conformance. Source-specific
assertions provide that additional evidence for the covered cases.

## Cost and live writing

The export performs no model calls, network requests or git operations. It reads source rows
and writes uncompressed JSONL, retaining one thread's projections plus small bundle indexes in
memory. File buffers are flushed at approximately 256 KiB; a single source item can be larger.
The snapshot's read lock can retain WAL pages while a running server writes, so a large export
can temporarily increase WAL disk usage. Synchronous I/O is intentional for the offline CLI;
calling this implementation directly on the serving event loop would block it. A future UI,
HTTP or MCP action should run an export worker and return a downloadable job result.

A representative local export of roughly 720 threads produced about 2.4 GB in under a minute,
with roughly 1.3 GB peak RSS. Memory scales with the largest thread; output includes retained
audit revisions as well as final content. These are observations, not resource limits or a
performance guarantee. The reference validator supports `--streaming`, which discards transcript payloads after each
stream while retaining reference evidence. Its memory still depends on semantic indexes and
diagnostics; missing backing sessions produce availability warnings under v3.1.

L2 live writing needs a durable export outbox committed with orchestration events, a stable
per-thread ASR sequence/cursor, and idempotent recovery after a partially written JSONL tail.
Each item update must become an explicit `supersedes` revision. Backing-session additions become
`declaration` records. The outbox must precede event compaction, and writer delivery must not
block the run path. Backfill needs a marked snapshot-to-live boundary instead of pretending
that the older compacted history has live observation order. Bundle manifests should be sealed
at snapshot boundaries, with new digests after subsequent appends. This is intentionally deferred
until maintainers choose retention, worker ownership and crash-recovery semantics.

import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as AsrExport from "../asr/AsrExport.ts";

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const asrCommand = Command.make("export-asr", {
  userdata: Flag.String("userdata").pipe(
    Flag.withDefault(`${NodeOS.homedir()}/.t3/userdata`),
    Flag.withDescription(
      "Existing T3 userdata directory. Opened read-only; no server or migrations are started.",
    ),
  ),
  output: Flag.String("output").pipe(
    Flag.withDescription(
      "New private bundle directory. Its parent must exist; existing destinations are never overwritten.",
    ),
  ),
  thread: Flag.String("thread").pipe(
    Flag.optional,
    Flag.withDescription("Export this native T3 thread ID, including archived or deleted threads."),
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Export all threads, including subagents, archived and deleted threads."),
  ),
}).pipe(
  Command.withDescription(
    "Export private Agent Session Record (ASR 0.1) streams and bundle.json from T3's event store.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.all === Option.isSome(flags.thread))
        return yield* new CliError.UserError({
          cause: "Specify exactly one of --all or --thread <id>.",
        });
      const exporter = yield* AsrExport.AsrExport;
      const summary = yield* exporter.exportBundle({
        userdata: flags.userdata,
        output: flags.output,
        ...Option.match(flags.thread, { onNone: () => ({}), onSome: (threadId) => ({ threadId }) }),
      });
      yield* Console.log(encodeSummary(summary));
    }).pipe(
      Effect.provide(AsrExport.layer),
      Effect.catchTags({
        AsrExportError: (error) => Effect.fail(new CliError.UserError({ cause: error.message })),
      }),
    ),
  ),
);

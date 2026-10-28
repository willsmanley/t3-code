import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type DirectPushDeviceRegistrationInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { androidDirectPushProjectId, resolveDirectPushEnvironmentIds } from "./directPush";
import {
  type AgentAwarenessDirectPushTarget,
  setAgentAwarenessDirectPushTarget,
} from "./remoteRegistration";

const sendDirectPushRegistration = createRuntimeCommand(connectionAtomRuntime, {
  label: "agent-awareness:direct-push-registration",
  execute: Effect.fn("sendDirectPushRegistration")(function* (input: {
    readonly environmentIds: ReadonlyArray<EnvironmentId>;
    readonly deviceId: string;
    readonly registration: DirectPushDeviceRegistrationInput | null;
    readonly pushToken?: string;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const accepted = yield* Effect.forEach(
      input.environmentIds,
      (environmentId) =>
        registry
          .run(
            environmentId,
            input.registration
              ? request(WS_METHODS.serverRegisterPushDevice, input.registration)
              : request(WS_METHODS.serverUnregisterPushDevice, {
                  deviceId: input.deviceId,
                  ...(input.pushToken ? { pushToken: input.pushToken } : {}),
                }),
          )
          .pipe(
            // An unreachable server must not hold up the others or the next
            // registration; the next foreground retries it.
            Effect.timeout("15 seconds"),
            Effect.as([environmentId]),
            Effect.catchCause(() => Effect.succeed([])),
          ),
      { concurrency: "unbounded" },
    );
    return accepted.flat();
  }),
});

const send: AgentAwarenessDirectPushTarget["send"] = async (input) => {
  const result = await sendDirectPushRegistration.run(appAtomRegistry, input);
  return AsyncResult.isSuccess(result) ? result.value : [];
};

/** Keeps this device registered with every connected server that pushes through its Firebase project. */
export function useAgentAwarenessDirectPush(): void {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const environmentIds = useMemo(
    () => resolveDirectPushEnvironmentIds(configs, androidDirectPushProjectId()),
    [configs],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the servers to the registration loop outside React
  useEffect(() => {
    setAgentAwarenessDirectPushTarget({ environmentIds, send });
  }, [environmentIds]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops direct push registration when the app shell unmounts
  useEffect(() => () => setAgentAwarenessDirectPushTarget(null), []);
}

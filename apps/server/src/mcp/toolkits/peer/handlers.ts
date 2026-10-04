import type { ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PeerEnvironmentService from "../../../peer/PeerEnvironmentService.ts";
import { readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { PeerToolkit } from "./tools.ts";

// A settings read that fails is this server's problem, not the peer's.
const settingsUnavailable = <A, E, R>(effect: Effect.Effect<A, E | ServerSettingsError, R>) =>
  effect.pipe(Effect.catchTag("ServerSettingsError", () => Effect.fail(unavailable())));

export const PeerHandlersLive = PeerToolkit.toLayer({
  t3_peer_environment_list: (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const configured = yield* peers.listPeers;
      return {
        peers:
          input.peerId === undefined
            ? configured
            : configured.filter((peer) => peer.peerId === input.peerId),
      };
    }).pipe(settingsUnavailable),
  t3_peer_thread_list: (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      return yield* peers.listThreads(input.peerId);
    }).pipe(settingsUnavailable),
  t3_peer_thread_read: (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      return yield* peers.readThread(input.peerId, input.threadId, {
        limit: input.limit ?? PeerEnvironmentService.PEER_MESSAGE_DEFAULT_LIMIT,
      });
    }).pipe(settingsUnavailable),
  t3_peer_thread_send: (input) =>
    Effect.gen(function* () {
      // Prompting another machine's agent is a mutation: only a provider that
      // still owns an active run of the calling thread may do it.
      const { scope } = yield* readMutationCaller();
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      return yield* peers.sendMessage(input.peerId, {
        threadId: input.threadId,
        text: input.text,
        clientRequestId: input.clientRequestId,
        sender: { environmentId: scope.environmentId, threadId: scope.threadId },
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      });
    }).pipe(settingsUnavailable),
});

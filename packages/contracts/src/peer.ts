/**
 * Peer - Another T3 environment this server is allowed to reach on an agent's
 * behalf.
 *
 * A peer is a separate T3 server (its own machine, projects, and threads)
 * reached over SSH. The list in server settings is the allowlist: an agent can
 * only address a peer that is configured here, by its id.
 *
 * @module Peer
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PeerEnvironmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand("PeerEnvironmentId"));
export type PeerEnvironmentId = typeof PeerEnvironmentId.Type;

/** SSH aliases and key paths are resolved on the environment server. */
export const PeerEnvironmentConfig = Schema.Struct({
  id: PeerEnvironmentId,
  label: TrimmedNonEmptyString,
  // No leading dash: the target is passed to ssh as an argument.
  target: TrimmedNonEmptyString.check(Schema.isPattern(/^[^\s-][^\s]*$/)),
  identityFile: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
});
export type PeerEnvironmentConfig = typeof PeerEnvironmentConfig.Type;

export const PeerEnvironmentConfigs = Schema.Array(PeerEnvironmentConfig).check(
  Schema.makeFilter(
    (peers) =>
      new Set(peers.map((peer) => peer.id)).size === peers.length ||
      "Peer environment ids must be unique.",
  ),
);

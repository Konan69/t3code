import { PeerEnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The peer id is not in `peerEnvironments`, so this server may not reach it. */
export class PeerEnvironmentNotConfigured extends Schema.TaggedError<PeerEnvironmentNotConfigured>()(
  "PeerEnvironmentNotConfigured",
  { peerId: Schema.String },
) {
  override get message(): string {
    return `No peer environment named '${this.peerId}' is configured on this server. Call t3_peer_environment_list for the configured peers.`;
  }
}

/**
 * SSH, the tunnel, or the peer's server did not answer. `detail` is a short
 * summary (the last line of SSH stderr when SSH failed), never a credential.
 */
export class PeerEnvironmentUnreachable extends Schema.TaggedError<PeerEnvironmentUnreachable>()(
  "PeerEnvironmentUnreachable",
  { peerId: PeerEnvironmentId, detail: Schema.String },
) {
  override get message(): string {
    return `Peer environment '${this.peerId}' could not be reached: ${this.detail}`;
  }
}

/** The peer rejected this server's credential, also after pairing again. */
export class PeerEnvironmentUnauthorized extends Schema.TaggedError<PeerEnvironmentUnauthorized>()(
  "PeerEnvironmentUnauthorized",
  { peerId: PeerEnvironmentId, detail: Schema.String },
) {
  override get message(): string {
    return `Peer environment '${this.peerId}' refused this server's credential: ${this.detail}`;
  }
}

export class PeerThreadNotFound extends Schema.TaggedError<PeerThreadNotFound>()(
  "PeerThreadNotFound",
  { peerId: PeerEnvironmentId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' was not found on peer environment '${this.peerId}'. Call t3_peer_thread_list for its threads.`;
  }
}

/** The peer answered in a shape this build cannot read: it runs another T3 version. */
export class PeerProtocolMismatch extends Schema.TaggedError<PeerProtocolMismatch>()(
  "PeerProtocolMismatch",
  { peerId: PeerEnvironmentId, detail: Schema.String },
) {
  override get message(): string {
    return `Peer environment '${this.peerId}' runs an incompatible T3 version: ${this.detail}`;
  }
}

/** The peer received the prompt and declined it; sending it again will not help. */
export class PeerCommandRejected extends Schema.TaggedError<PeerCommandRejected>()(
  "PeerCommandRejected",
  { peerId: PeerEnvironmentId, threadId: ThreadId, detail: Schema.String },
) {
  override get message(): string {
    return `Peer environment '${this.peerId}' rejected the message for thread '${this.threadId}': ${this.detail}`;
  }
}

/** Attachments are files on this machine; the peer has no way to read them. */
export class PeerAttachmentsUnsupported extends Schema.TaggedError<PeerAttachmentsUnsupported>()(
  "PeerAttachmentsUnsupported",
  { peerId: Schema.String },
) {
  override get message(): string {
    return "Attachments cannot be sent to a peer environment: they would point at files on this machine. Send text only.";
  }
}

export const PeerEnvironmentError = Schema.Union([
  PeerEnvironmentNotConfigured,
  PeerEnvironmentUnreachable,
  PeerEnvironmentUnauthorized,
  PeerThreadNotFound,
  PeerProtocolMismatch,
  PeerCommandRejected,
  PeerAttachmentsUnsupported,
]);
export type PeerEnvironmentError = typeof PeerEnvironmentError.Type;

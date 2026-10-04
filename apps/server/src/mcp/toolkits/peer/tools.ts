import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerEnvironmentService from "../../../peer/PeerEnvironmentService.ts";
import { PeerEnvironmentError } from "../../../peer/PeerErrors.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, PeerEnvironmentError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PeerEnvironmentService.PeerEnvironmentService,
  ],
};

const peerId = Schema.String.annotate({
  description: "A peer id from t3_peer_environment_list.",
});

const PeerEnvironmentListTool = Tool.make("t3_peer_environment_list", {
  ...shared,
  description:
    "List the other T3 environments (separate machines running their own T3 server) this server is allowed to reach, and whether a connection to each is open right now. Reads configuration only: it never connects and never wakes a sleeping machine.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    peerId: Schema.optional(
      Schema.String.annotate({ description: "Limit to one peer. Defaults to all peers." }),
    ),
  }),
  success: Schema.Struct({
    peers: Schema.Array(PeerEnvironmentService.PeerEnvironmentSummary),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PeerThreadListTool = Tool.make("t3_peer_thread_list", {
  ...shared,
  description: `List threads on a peer T3 environment: id, title, project, status, and last activity, most recently active first (at most ${PeerEnvironmentService.PEER_THREAD_LIST_LIMIT}). Connects over SSH, which wakes the peer machine if it is asleep. A cold start can take a few minutes: if the call returns PeerEnvironmentWaking, the connection is still being opened in the background, so call again in about 30 seconds.`,
  parameters: Schema.Struct({ peerId }),
  success: PeerEnvironmentService.PeerThreadList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PeerThreadReadTool = Tool.make("t3_peer_thread_read", {
  ...shared,
  description: `Read a thread on a peer T3 environment: its status and its most recent messages, oldest first. Each message is cut at ${PeerEnvironmentService.PEER_MESSAGE_TEXT_LIMIT} characters with a marker. Use this to follow a prompt sent with t3_peer_thread_send; leave at least 30 seconds between reads, because every call keeps the peer machine awake. On PeerEnvironmentWaking, repeat the call after about 30 seconds.`,
  parameters: Schema.Struct({
    peerId,
    threadId: ThreadId,
    limit: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: PeerEnvironmentService.PEER_MESSAGE_MAX_LIMIT }),
      ).annotate({
        description: `How many of the latest messages to return. Defaults to ${PeerEnvironmentService.PEER_MESSAGE_DEFAULT_LIMIT}.`,
      }),
    ),
  }),
  success: PeerEnvironmentService.PeerThreadDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PeerThreadSendTool = Tool.make("t3_peer_thread_send", {
  ...shared,
  description:
    "Send a text prompt into an existing thread on a peer T3 environment, where that thread's agent acts on it. Returns as soon as the peer accepts the prompt and does not wait for the reply: follow up with t3_peer_thread_read. Repeating a call with the same clientRequestId never posts the prompt twice, so on PeerEnvironmentWaking (the peer machine is still starting) or any other failure where the outcome is unclear, repeat the call with the same clientRequestId after about 30 seconds. The peer thread may not run with a broader runtime or interaction mode than the calling thread. Attachments are not supported.",
  parameters: Schema.Struct({
    peerId,
    threadId: ThreadId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100000)),
    clientRequestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description:
        "A key you choose for this prompt. Reuse it when retrying the same prompt; use a new one for a new prompt.",
    }),
    attachments: Schema.optional(
      Schema.Array(Schema.Unknown).annotate({
        description: "Not supported: files on this machine are not readable from the peer.",
      }),
    ),
  }),
  success: PeerEnvironmentService.PeerSendResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const PeerToolkit = Toolkit.make(
  PeerEnvironmentListTool,
  PeerThreadListTool,
  PeerThreadReadTool,
  PeerThreadSendTool,
);

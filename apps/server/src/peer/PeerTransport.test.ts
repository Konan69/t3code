import { assert, it } from "@effect/vitest";

import { hasCompatibleOrchestrationProtocol } from "../ws.ts";
import { peerSocketUrl } from "./PeerTransport.ts";

it("builds a command socket URL the peer's upgrade gate accepts", () => {
  const url = new URL(
    peerSocketUrl(
      { httpBaseUrl: "http://127.0.0.1:4100/", wsBaseUrl: "ws://127.0.0.1:4100/" },
      "ticket-1",
    ),
  );
  // The server's own check for `/ws`: without the protocol parameter it
  // answers 426 before any RPC is read.
  assert.isTrue(hasCompatibleOrchestrationProtocol(url));
  assert.strictEqual(url.pathname, "/ws");
  assert.strictEqual(url.searchParams.get("wsTicket"), "ticket-1");
});

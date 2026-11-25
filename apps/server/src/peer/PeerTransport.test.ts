import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION, PeerEnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { hasCompatibleOrchestrationProtocol } from "../ws.ts";
import { peerProtocolMismatch, peerSocketUrl, refusesSocketProtocol } from "./PeerTransport.ts";

const link = { httpBaseUrl: "http://127.0.0.1:4100/", wsBaseUrl: "ws://127.0.0.1:4100/" };
const boat = { id: PeerEnvironmentId.make("boat"), label: "Boat box", target: "boat" };

describe("peer command socket", () => {
  it("builds a URL the peer's upgrade gate accepts", () => {
    const url = new URL(peerSocketUrl(link, "ticket-1"));
    // The server's own check for `/ws`: without the protocol parameter it
    // answers 426 before any RPC is read.
    assert.isTrue(hasCompatibleOrchestrationProtocol(url));
    assert.strictEqual(url.pathname, "/ws");
    assert.strictEqual(url.searchParams.get("wsTicket"), "ticket-1");
  });

  // A peer answering every request with one status, as its `/ws` route does
  // before a socket exists.
  const answering = (status: number, seen: string[]) =>
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.url);
        return HttpClientResponse.fromWeb(request, new Response(null, { status }));
      }),
    );

  it.effect("recognizes a protocol refusal by its status, over plain HTTP", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      assert.isTrue(yield* refusesSocketProtocol(answering(426, seen), link));
      assert.isTrue(seen[0]?.startsWith("http://127.0.0.1:4100/ws"));
      // A refused ticket or a missing route is not a protocol refusal.
      assert.isFalse(yield* refusesSocketProtocol(answering(401, seen), link));
      assert.isFalse(yield* refusesSocketProtocol(answering(404, seen), link));
    }),
  );
});

describe("peer protocol negotiation", () => {
  it("treats a peer that advertises no protocol as the original protocol", () => {
    const legacy = peerProtocolMismatch(boat, { serverVersion: "0.0.30" });
    assert.strictEqual(legacy?._tag, "PeerProtocolMismatch");
    assert.include(legacy?.detail, "protocol 1");
  });

  it("accepts this build's protocol and refuses a newer one", () => {
    assert.isNull(
      peerProtocolMismatch(boat, {
        serverVersion: "0.0.45",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      }),
    );
    assert.strictEqual(
      peerProtocolMismatch(boat, {
        serverVersion: "0.1.0",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
      })?._tag,
      "PeerProtocolMismatch",
    );
  });
});

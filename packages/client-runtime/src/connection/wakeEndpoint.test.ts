import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import type { RelayWakePolicy } from "./model.ts";
import {
  WAKE_ENDPOINT_TIMEOUT_MS,
  type WakeEndpointFetch,
  type WakeStatusFetch,
  wakeEndpoint,
  wakeStatus,
} from "./wakeEndpoint.ts";

const POLICY: RelayWakePolicy = {
  endpoint: "https://wake.example.test/",
  name: "konan dev",
  secret: "wake-secret",
  mode: "explicit-intent",
};

describe("wakeEndpoint", () => {
  it.effect.each([
    [202, { _tag: "Resuming" }],
    [200, { _tag: "Running" }],
    [409, { _tag: "UnsupportedState" }],
    [401, { _tag: "Unauthorized" }],
    [503, { _tag: "UnexpectedResponse", status: 503 }],
  ] as const)("maps HTTP status %s without retrying", ([status, expected]) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly input: string; readonly init: RequestInit }> = [];
      const request: WakeEndpointFetch = (input, init) => {
        requests.push({ input, init });
        return Promise.resolve({ status });
      };

      expect(yield* wakeEndpoint(POLICY, request)).toEqual(expected);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.input).toBe("https://wake.example.test/wake/konan%20dev");
      expect(requests[0]?.init).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer wake-secret" },
      });
    }),
  );

  it.effect("returns a timeout after five seconds and does not retry", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const request: WakeEndpointFetch = (_input, init) => {
        requestCount += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      };
      const fiber = yield* Effect.forkChild(wakeEndpoint(POLICY, request));

      yield* TestClock.adjust(WAKE_ENDPOINT_TIMEOUT_MS - 1);
      expect(requestCount).toBe(1);
      yield* TestClock.adjust(1);

      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "TimedOut" });
      expect(requestCount).toBe(1);
    }),
  );

  it.effect("converts request failures into a non-throwing result", () =>
    Effect.gen(function* () {
      const result = yield* wakeEndpoint(POLICY, () => Promise.reject(new Error("unreachable")));

      expect(result).toEqual({ _tag: "RequestFailed" });
    }),
  );
});

describe("wakeStatus", () => {
  it.effect.each([
    ["suspended", "suspended"],
    ["running", "running"],
    ["resuming", "resuming"],
    ["stopped", "stopped"],
    ["provisioning", "other"],
  ] as const)("parses %s status responses", ([state, expectedState]) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly input: string; readonly init: RequestInit }> = [];
      const request: WakeStatusFetch = (input, init) => {
        requests.push({ input, init });
        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              state,
              gceStatus: "RUNNING",
              name: "konan dev",
            }),
        });
      };

      expect(yield* wakeStatus(POLICY, request)).toEqual({
        _tag: "Status",
        state: expectedState,
        gceStatus: "RUNNING",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.input).toBe("https://wake.example.test/status/konan%20dev");
      expect(requests[0]?.init).toMatchObject({
        method: "GET",
        headers: { Authorization: "Bearer wake-secret" },
      });
    }),
  );

  it.effect("returns Unauthorized without parsing the response body", () =>
    Effect.gen(function* () {
      let bodyReadCount = 0;
      const result = yield* wakeStatus(POLICY, () =>
        Promise.resolve({
          status: 401,
          json: () => {
            bodyReadCount += 1;
            return Promise.resolve({});
          },
        }),
      );

      expect(result).toEqual({ _tag: "Unauthorized" });
      expect(bodyReadCount).toBe(0);
    }),
  );

  it.effect.each([
    [{ state: "running", gceStatus: "RUNNING" }],
    [{ state: "running", gceStatus: 1, name: "konan dev" }],
    [{ state: "running", gceStatus: "RUNNING", name: "konan dev", extra: true }],
  ])("maps an invalid 200 response to UnexpectedResponse", ([body]) =>
    Effect.gen(function* () {
      const result = yield* wakeStatus(POLICY, () =>
        Promise.resolve({ status: 200, json: () => Promise.resolve(body) }),
      );

      expect(result).toEqual({ _tag: "UnexpectedResponse", status: 200 });
    }),
  );

  it.effect("returns a timeout after five seconds and does not retry", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const request: WakeStatusFetch = (_input, init) => {
        requestCount += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      };
      const fiber = yield* Effect.forkChild(wakeStatus(POLICY, request));

      yield* TestClock.adjust(WAKE_ENDPOINT_TIMEOUT_MS - 1);
      expect(requestCount).toBe(1);
      yield* TestClock.adjust(1);

      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "TimedOut" });
      expect(requestCount).toBe(1);
    }),
  );

  it.effect("never throws for request or JSON failures", () =>
    Effect.gen(function* () {
      expect(yield* wakeStatus(POLICY, () => Promise.reject(new Error("unreachable")))).toEqual({
        _tag: "RequestFailed",
      });
      expect(
        yield* wakeStatus(POLICY, () =>
          Promise.resolve({
            status: 200,
            json: () => Promise.reject(new Error("invalid JSON")),
          }),
        ),
      ).toEqual({ _tag: "UnexpectedResponse", status: 200 });
    }),
  );
});

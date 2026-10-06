import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as BoatClient from "./BoatClient.ts";

const apiKey = "test-boat-secret";
const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(Json);
const decodeJson = Schema.decodeUnknownSync(Json);
const name = "cloudbox-konan";
const env = { BOAT_API_KEY: apiKey, CLOUDBOX_BOAT_NAME: name };
const sandbox = {
  id: "box/1",
  name,
  state: "running",
  type: "large",
  vcpu: 4,
  memoryGB: 16,
  archiveAfter: "2026-10-03T16:00:00Z",
};
const limits = { ok: true, type: "limits.info", creditBalanceHours: 42.5 };
const list = (sandboxes: readonly unknown[], nextCursor: string | null = null) => ({
  ok: true,
  type: "sandbox.list",
  sandboxes,
  pageInfo: { nextCursor, hasMore: nextCursor !== null, limit: 200 },
});

function testLayer(
  respond: (request: HttpClientRequest.HttpClientRequest) => {
    readonly body: unknown;
    readonly status?: number;
  },
  config: Readonly<Record<string, string | undefined>> = env,
) {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.url.startsWith("https://boat.dev/api/v1/")).toBe(true);
        expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
        const response = respond(request);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(response.body, {
            status: response.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  return BoatClient.layer.pipe(
    Layer.provide(httpLayer),
    Layer.provideMerge(DesktopConfig.layerTest(config)),
  );
}

describe("BoatClient", () => {
  it.effect.each([
    ["init", "starting"],
    ["provisioning", "starting"],
    ["provisioned", "starting"],
    ["cloning", "starting"],
    ["ready", "running"],
    ["idle", "running"],
    ["running", "running"],
    ["archiving", "stopping"],
    ["archived", "stopped"],
    ["error", "error"],
    ["unexpected-state", "error"],
  ] as const)("maps Boat state %s to %s and preserves the raw state", ([rawState, state]) =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.getBoatStatus()).toEqual({
        _tag: "Box",
        box: {
          id: sandbox.id,
          name,
          state,
          rawState,
          machineType: "large",
          vcpu: 4,
          memoryGB: 16,
          stopsAt: state === "running" ? sandbox.archiveAfter : null,
          creditBalanceHours: 42.5,
        },
      });
    }).pipe(
      Effect.provide(
        testLayer((request) => ({
          body: request.url.endsWith("/limits") ? limits : list([{ ...sandbox, state: rawState }]),
        })),
      ),
    ),
  );

  it.effect.each([
    { config: {}, missing: ["BOAT_API_KEY", "CLOUDBOX_BOAT_NAME"] },
    { config: { CLOUDBOX_BOAT_NAME: name }, missing: ["BOAT_API_KEY"] },
    { config: { BOAT_API_KEY: apiKey }, missing: ["CLOUDBOX_BOAT_NAME"] },
    {
      config: { BOAT_API_KEY: "  ", CLOUDBOX_BOAT_NAME: " " },
      missing: ["BOAT_API_KEY", "CLOUDBOX_BOAT_NAME"],
    },
  ])(
    "reports missing configuration: $missing without making HTTP requests",
    ({ config, missing }) =>
      Effect.gen(function* () {
        const client = yield* BoatClient.BoatClient;
        const expected = { _tag: "NotConfigured", missing };
        expect(yield* client.getBoatStatus()).toEqual(expected);
        expect(yield* client.stopBoatBox()).toEqual(expected);
        expect(yield* client.resumeBoatBox()).toEqual(expected);
        expect(yield* client.setBoatBoxLifetime({ ttlSeconds: null })).toEqual(expected);
      }).pipe(
        Effect.provide(
          testLayer(() => {
            throw new Error("Unexpected HTTP request");
          }, config),
        ),
      ),
  );

  it.effect("trims configuration, defaults TTL, and keeps the API key redacted", () =>
    Effect.gen(function* () {
      const config = yield* DesktopConfig.DesktopConfig;
      const key = Option.getOrThrow(config.boatApiKey);
      expect(Redacted.isRedacted(key)).toBe(true);
      expect(String(key)).not.toContain(apiKey);
      expect(encodeJson(config)).not.toContain(apiKey);
      expect(Redacted.value(key)).toBe(apiKey);
      expect(Option.getOrThrow(config.cloudboxBoatName)).toBe(name);
      expect(config.cloudboxBoatTtlSeconds).toBe(7200);
    }).pipe(
      Effect.provide(
        DesktopConfig.layerTest({
          BOAT_API_KEY: ` ${apiKey} `,
          CLOUDBOX_BOAT_NAME: ` ${name} `,
        }),
      ),
    ),
  );

  it.effect("returns NotFound when only differently named boxes exist", () =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.getBoatStatus()).toEqual({ _tag: "NotFound", name });
      expect(yield* client.stopBoatBox()).toEqual({ _tag: "NotFound", name });
    }).pipe(
      Effect.provide(
        testLayer((request) => {
          expect(request.method).toBe("GET");
          expect(request.url).toBe("https://boat.dev/api/v1/sandboxes?limit=200&sort=desc");
          return { body: list([{ ...sandbox, name: "other" }]) };
        }),
      ),
    ),
  );

  it.effect.each([false, true])("rejects duplicate names (across pages: %s)", (paginate) =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.resumeBoatBox()).toEqual({
        _tag: "RequestFailed",
        message: `multiple boxes named ${name}`,
      });
    }).pipe(
      Effect.provide(
        testLayer((request) => {
          expect(request.method).toBe("GET");
          if (!paginate) return { body: list([sandbox, { ...sandbox, id: "box-2" }]) };
          return {
            body: request.url.includes("cursor=")
              ? list([{ ...sandbox, id: "box-2" }])
              : list([sandbox], "next page"),
          };
        }),
      ),
    ),
  );

  it.effect("finds stopped boxes on later pages and leaves missing metadata null", () =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.getBoatStatus()).toEqual({
        _tag: "Box",
        box: {
          id: "minimal",
          name,
          state: "stopped",
          rawState: "archived",
          machineType: null,
          vcpu: null,
          memoryGB: null,
          stopsAt: null,
          creditBalanceHours: null,
        },
      });
    }).pipe(
      Effect.provide(
        testLayer((request) => {
          if (request.url.endsWith("/limits")) return { body: { ok: true, type: "limits.info" } };
          if (request.url.includes("cursor=")) {
            expect(request.url).toContain("cursor=next+page");
            return { body: list([{ id: "minimal", name, state: "archived" }]) };
          }
          return { body: list([], "next page") };
        }),
      ),
    ),
  );

  it.effect.each([
    {
      action: "stop",
      method: "POST",
      suffix: "/stop",
      body: {},
      rawState: "archiving",
      ttl: undefined,
    },
    {
      action: "resume",
      method: "POST",
      suffix: "/resume",
      body: { type: "large", ttlSeconds: 7200 },
      rawState: "provisioning",
      ttl: undefined,
    },
    {
      action: "resume",
      method: "POST",
      suffix: "/resume",
      body: { type: "large", ttlSeconds: 3600 },
      rawState: "ready",
      ttl: "3600",
    },
    {
      action: "lifetime",
      method: "PATCH",
      suffix: "",
      body: { ttlSeconds: 1800 },
      rawState: "ready",
      ttl: undefined,
    },
    {
      action: "lifetime",
      method: "PATCH",
      suffix: "",
      body: { ttlSeconds: null },
      rawState: "ready",
      ttl: undefined,
    },
  ] as const)("$action sends $method with $body and returns refreshed status", (scenario) => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    let mutated = false;
    const refreshed = {
      ...sandbox,
      state: scenario.rawState,
      archiveAfter:
        scenario.action === "lifetime" && scenario.body.ttlSeconds === null
          ? null
          : "2026-10-03T18:00:00Z",
    };
    return Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      const result =
        scenario.action === "stop"
          ? yield* client.stopBoatBox()
          : scenario.action === "resume"
            ? yield* client.resumeBoatBox()
            : yield* client.setBoatBoxLifetime({ ttlSeconds: scenario.body.ttlSeconds });
      expect(result._tag).toBe("Box");
      if (result._tag !== "Box") return;
      expect(result.box.rawState).toBe(scenario.rawState);
      expect(result.box.stopsAt).toBe(
        scenario.rawState === "ready" ? refreshed.archiveAfter : null,
      );
      expect(result.box.creditBalanceHours).toBe(17);
      expect(requests.map((request) => [request.method, request.url])).toEqual([
        ["GET", "https://boat.dev/api/v1/sandboxes?limit=200&sort=desc"],
        [scenario.method, `https://boat.dev/api/v1/sandboxes/box%2F1${scenario.suffix}`],
        ["GET", "https://boat.dev/api/v1/sandboxes?limit=200&sort=desc"],
        ["GET", "https://boat.dev/api/v1/limits"],
      ]);
      const mutation = requests[1]!;
      expect(mutation.body._tag).toBe("Uint8Array");
      if (mutation.body._tag === "Uint8Array") {
        expect(decodeJson(new TextDecoder().decode(mutation.body.body))).toEqual(scenario.body);
      }
      expect(encodeJson(result)).not.toContain(apiKey);
    }).pipe(
      Effect.provide(
        testLayer(
          (request) => {
            requests.push(request);
            if (request.method !== "GET") {
              mutated = true;
              return {
                body:
                  scenario.method === "PATCH"
                    ? { ok: true, type: "sandbox.updated", sandbox: refreshed }
                    : {
                        ok: true,
                        type: "sandbox.action",
                        id: sandbox.id,
                        status: scenario.rawState,
                      },
              };
            }
            return {
              body: request.url.endsWith("/limits")
                ? { ...limits, creditBalanceHours: 17 }
                : list([mutated ? refreshed : sandbox]),
            };
          },
          { ...env, CLOUDBOX_BOAT_TTL_SECONDS: scenario.ttl },
        ),
      ),
    );
  });

  it.effect.each([200, 401])("returns a safe failure for API error envelopes (HTTP %s)", (status) =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      const result = yield* client.getBoatStatus();
      expect(result).toEqual({ _tag: "RequestFailed", message: "Boat API request failed." });
      expect(encodeJson(result)).not.toContain(apiKey);
    }).pipe(
      Effect.provide(
        testLayer(() => ({
          status,
          body: { ok: false, code: "unauthorized", message: `Invalid key ${apiKey}\nstack trace` },
        })),
      ),
    ),
  );

  it.effect("turns transport defects into safe status data", () =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.getBoatStatus()).toEqual({
        _tag: "RequestFailed",
        message: "Boat API request failed.",
      });
    }).pipe(
      Effect.provide(
        testLayer(() => {
          throw new Error(`Transport error containing ${apiKey}`);
        }),
      ),
    ),
  );

  it.effect("rejects malformed response fields at the HTTP boundary", () =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.getBoatStatus()).toEqual({
        _tag: "RequestFailed",
        message: "Boat API request failed.",
      });
    }).pipe(Effect.provide(testLayer(() => ({ body: list([{ ...sandbox, vcpu: "four" }]) })))),
  );

  it.effect("does not resume a box without a machine type", () =>
    Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.resumeBoatBox()).toEqual({
        _tag: "RequestFailed",
        message: "Boat box has no machine type.",
      });
    }).pipe(
      Effect.provide(
        testLayer((request) => {
          expect(request.method).toBe("GET");
          return { body: list([{ ...sandbox, type: null }]) };
        }),
      ),
    ),
  );

  it.effect("returns failure when Boat refuses a mutation without refreshing", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const client = yield* BoatClient.BoatClient;
      expect(yield* client.stopBoatBox()).toEqual({
        _tag: "RequestFailed",
        message: "Boat API request failed.",
      });
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        testLayer((request) => {
          calls += 1;
          return request.method === "GET"
            ? { body: list([sandbox]) }
            : { status: 409, body: { ok: false, code: "conflict", message: apiKey } };
        }),
      ),
    );
  });
});

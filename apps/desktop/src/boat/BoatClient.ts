import { DesktopBoatStatus, type DesktopBoatBoxState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as DesktopConfig from "../app/DesktopConfig.ts";

const Sandbox = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  state: Schema.String,
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  vcpu: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  memoryGB: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  archiveAfter: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const SandboxList = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("sandbox.list"),
  sandboxes: Schema.Array(Sandbox),
  pageInfo: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
});
const Limits = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("limits.info"),
  creditBalanceHours: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const SandboxAction = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
});
const SandboxUpdated = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("sandbox.updated"),
  sandbox: Sandbox,
});
const ApiError = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.String,
  message: Schema.String,
});
const Lifetime = Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)));
const decodeLifetime = Schema.decodeUnknownEffect(Lifetime);

class BoatRequestError extends Schema.TaggedError<BoatRequestError>()("BoatRequestError", {
  message: Schema.String,
}) {}

const boxState = (rawState: string): DesktopBoatBoxState => {
  switch (rawState) {
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
      return "starting";
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archiving":
      return "stopping";
    case "archived":
      return "stopped";
    default:
      return "error";
  }
};

export class BoatClient extends Context.Service<
  BoatClient,
  {
    readonly getBoatStatus: () => Effect.Effect<DesktopBoatStatus>;
    readonly resumeBoatBox: () => Effect.Effect<DesktopBoatStatus>;
    readonly stopBoatBox: () => Effect.Effect<DesktopBoatStatus>;
    readonly setBoatBoxLifetime: (input: {
      readonly ttlSeconds: number | null;
    }) => Effect.Effect<DesktopBoatStatus>;
  }
>()("@t3tools/desktop/boat/BoatClient") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  const operate = Effect.fnUntraced(function* (
    action: "status" | "resume" | "stop" | "lifetime",
    ttlSeconds?: number | null,
  ): Effect.fn.Return<DesktopBoatStatus, BoatRequestError | Schema.SchemaError | ConfigError> {
    const config = yield* DesktopConfig.DesktopConfig;
    const missing: Array<"BOAT_API_KEY" | "CLOUDBOX_BOAT_NAME"> = [];
    if (Option.isNone(config.boatApiKey)) missing.push("BOAT_API_KEY");
    if (Option.isNone(config.cloudboxBoatName)) missing.push("CLOUDBOX_BOAT_NAME");
    if (Option.isNone(config.boatApiKey) || Option.isNone(config.cloudboxBoatName)) {
      return { _tag: "NotConfigured", missing };
    }
    const key = config.boatApiKey.value;
    const name = config.cloudboxBoatName.value;

    const request = <A extends { readonly ok: true }>(
      method: "GET" | "POST" | "PATCH",
      path: string,
      schema: Schema.Codec<A>,
      body?: unknown,
    ) => {
      const decode = Schema.decodeUnknownEffect(Schema.Union([schema, ApiError]));
      return Effect.gen(function* () {
        let req = HttpClientRequest.make(method)(`https://boat.dev/api/v1${path}`).pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.acceptJson,
        );
        if (body !== undefined) req = yield* HttpClientRequest.bodyJson(req, body);
        const response = yield* http.execute(req);
        const decoded = yield* decode(yield* response.json);
        if (!decoded.ok || response.status < 200 || response.status >= 300) {
          // API messages and transport errors can echo credentials. Only fixed messages cross IPC.
          return yield* new BoatRequestError({ message: "Boat API request failed." });
        }
        return decoded;
      }).pipe(
        Effect.scoped,
        Effect.timeout("20 seconds"),
        Effect.catchCause(() =>
          Effect.fail(new BoatRequestError({ message: "Boat API request failed." })),
        ),
      );
    };

    const findBox = Effect.fnUntraced(function* () {
      const matches: Array<typeof Sandbox.Type> = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      while (true) {
        const query = new URLSearchParams({ limit: "200", sort: "desc" });
        if (cursor !== null) query.set("cursor", cursor);
        const page = yield* request("GET", `/sandboxes?${query}`, SandboxList);
        matches.push(...page.sandboxes.filter((box) => box.name === name));
        if (matches.length > 1) {
          return yield* new BoatRequestError({ message: `multiple boxes named ${name}` });
        }
        if (!page.pageInfo.hasMore) return matches[0] ?? null;
        cursor = page.pageInfo.nextCursor;
        if (cursor === null || cursors.has(cursor)) {
          return yield* new BoatRequestError({ message: "Boat returned invalid pagination." });
        }
        cursors.add(cursor);
      }
    });

    let box = yield* findBox();
    if (box === null) return { _tag: "NotFound", name };
    const path = `/sandboxes/${encodeURIComponent(box.id)}`;
    switch (action) {
      case "resume": {
        if (!box.type) {
          return yield* new BoatRequestError({ message: "Boat box has no machine type." });
        }
        const lifetime = yield* decodeLifetime(config.cloudboxBoatTtlSeconds);
        yield* request("POST", `${path}/resume`, SandboxAction, {
          type: box.type,
          ttlSeconds: lifetime,
        });
        break;
      }
      case "stop":
        yield* request("POST", `${path}/stop`, SandboxAction, {});
        break;
      case "lifetime":
        yield* request("PATCH", path, SandboxUpdated, {
          ttlSeconds: yield* decodeLifetime(ttlSeconds),
        });
        break;
    }
    if (action !== "status") {
      box = yield* findBox();
      if (box === null) return { _tag: "NotFound", name };
    }
    const limits = yield* request("GET", "/limits", Limits);
    const state = boxState(box.state);
    return {
      _tag: "Box",
      box: {
        id: box.id,
        name: box.name,
        state,
        rawState: box.state,
        machineType: box.type ?? null,
        vcpu: box.vcpu ?? null,
        memoryGB: box.memoryGB ?? null,
        stopsAt: state === "running" ? (box.archiveAfter ?? null) : null,
        creditBalanceHours: limits.creditBalanceHours ?? null,
      },
    };
  });

  const status = (action: Parameters<typeof operate>[0], ttlSeconds?: number | null) =>
    operate(action, ttlSeconds).pipe(
      Effect.catchTags({
        BoatRequestError: ({ message }) =>
          Effect.succeed(DesktopBoatStatus.cases.RequestFailed.make({ message })),
      }),
      Effect.catchCause(() =>
        Effect.succeed(
          DesktopBoatStatus.cases.RequestFailed.make({ message: "Boat request failed." }),
        ),
      ),
    );

  return BoatClient.of({
    getBoatStatus: () => status("status"),
    resumeBoatBox: () => status("resume"),
    stopBoatBox: () => status("stop"),
    setBoatBoxLifetime: ({ ttlSeconds }) => status("lifetime", ttlSeconds),
  });
});

export const layer = Layer.effect(BoatClient, make);

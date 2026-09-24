import type {
  RelayEnvironmentHostLifecycleConfigRequest,
  RelayEnvironmentHostStatusResponse,
  RelayEnvironmentWakeResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as RelayConfiguration from "../Config.ts";
import { decryptHostLifecycleSecret, encryptHostLifecycleSecret } from "./HostLifecycleCrypto.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

const REQUEST_TIMEOUT_MS = 10_000;

export class HostLifecycleNotAuthorized extends Schema.TaggedErrorClass<HostLifecycleNotAuthorized>()(
  "HostLifecycleNotAuthorized",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    reason: Schema.Literals(["environment_link_not_found", "host_lifecycle_not_configured"]),
  },
) {}

export class HostLifecycleConfigInvalid extends Schema.TaggedErrorClass<HostLifecycleConfigInvalid>()(
  "HostLifecycleConfigInvalid",
  { reason: Schema.Literal("endpoint_invalid") },
) {}

export class HostLifecycleRequestFailed extends Schema.TaggedErrorClass<HostLifecycleRequestFailed>()(
  "HostLifecycleRequestFailed",
  {
    environmentId: Schema.String,
    reason: Schema.Literals(["endpoint_request_failed", "endpoint_response_invalid"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class HostLifecycleRequestTimedOut extends Schema.TaggedErrorClass<HostLifecycleRequestTimedOut>()(
  "HostLifecycleRequestTimedOut",
  { environmentId: Schema.String },
) {}
const isHostLifecycleRequestTimedOut = Schema.is(HostLifecycleRequestTimedOut);

export type HostLifecycleError =
  | HostLifecycleNotAuthorized
  | HostLifecycleConfigInvalid
  | HostLifecycleRequestFailed
  | HostLifecycleRequestTimedOut
  | EnvironmentLinks.EnvironmentLinkLookupPersistenceError
  | EnvironmentLinks.EnvironmentHostLifecyclePersistenceError;

export const normalizeHostLifecycleEndpoint = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || (url.pathname !== "/" && url.pathname !== "")) return null;
    if (url.search || url.hash || url.username || url.password) return null;
    if (url.port !== "" || !url.hostname.endsWith(".run.app")) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const StatusBody = Schema.Struct({
  state: Schema.Literals(["suspended", "running", "resuming", "stopped", "other"]),
  gceStatus: Schema.String,
  name: Schema.String,
});
const WakeBody = Schema.Struct({
  state: Schema.Literals(["running", "resuming"]),
  rateLimited: Schema.optional(Schema.Boolean),
});

export class HostLifecycle extends Context.Service<
  HostLifecycle,
  {
    readonly configure: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly config: RelayEnvironmentHostLifecycleConfigRequest;
    }) => Effect.Effect<boolean, HostLifecycleError>;
    readonly remove: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, HostLifecycleError>;
    readonly status: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayEnvironmentHostStatusResponse, HostLifecycleError>;
    readonly wake: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayEnvironmentWakeResponse, HostLifecycleError>;
  }
>()("t3code-relay/environments/HostLifecycle") {}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const keyMaterial = Redacted.value(config.cloudMintPrivateKey);

  const targetForUser = Effect.fn("relay.host_lifecycle.target_for_user")(function* (input: {
    readonly userId: string;
    readonly environmentId: string;
  }) {
    const link = yield* links.getForUser(input);
    if (link === null) {
      return yield* new HostLifecycleNotAuthorized({
        ...input,
        reason: "environment_link_not_found",
      });
    }
    if (link.hostLifecycleTarget === undefined) {
      return yield* new HostLifecycleNotAuthorized({
        ...input,
        reason: "host_lifecycle_not_configured",
      });
    }
    const target = link.hostLifecycleTarget;
    const secret = yield* Effect.tryPromise({
      try: () =>
        decryptHostLifecycleSecret({
          keyMaterial,
          environmentId: input.environmentId,
          ciphertext: target.encryptedSecret,
        }),
      catch: (cause) =>
        new HostLifecycleRequestFailed({
          environmentId: input.environmentId,
          reason: "endpoint_response_invalid",
          cause,
        }),
    });
    return { ...target, secret };
  });

  const request = Effect.fn("relay.host_lifecycle.request")(function* (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly operation: "status" | "wake";
  }) {
    const target = yield* targetForUser(input);
    const url = `${target.endpoint}/${input.operation}/${encodeURIComponent(target.name)}`;
    const request = (
      input.operation === "status" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.bearerToken(target.secret));
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeoutOption(Duration.millis(REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new HostLifecycleRequestTimedOut({ environmentId: input.environmentId })),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isHostLifecycleRequestTimedOut(cause)
          ? cause
          : new HostLifecycleRequestFailed({
              environmentId: input.environmentId,
              reason: "endpoint_request_failed",
              cause,
            }),
      ),
    );
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError(
        (cause) =>
          new HostLifecycleRequestFailed({
            environmentId: input.environmentId,
            reason: "endpoint_response_invalid",
            cause,
          }),
      ),
    );
  });

  return HostLifecycle.of({
    configure: Effect.fn("relay.host_lifecycle.configure")(function* (input) {
      const endpoint = normalizeHostLifecycleEndpoint(input.config.endpoint);
      if (endpoint === null) {
        return yield* new HostLifecycleConfigInvalid({ reason: "endpoint_invalid" });
      }
      const encryptedSecret = yield* Effect.tryPromise({
        try: () =>
          encryptHostLifecycleSecret({
            keyMaterial,
            environmentId: input.environmentId,
            secret: input.config.secret,
          }),
        catch: (cause) =>
          new EnvironmentLinks.EnvironmentHostLifecyclePersistenceError({
            operation: "configure",
            userId: input.userId,
            environmentId: input.environmentId,
            cause,
          }),
      });
      return yield* links.configureHostLifecycleForUser({
        userId: input.userId,
        environmentId: input.environmentId,
        provider: input.config.provider,
        endpoint,
        name: input.config.name,
        encryptedSecret,
      });
    }),
    remove: (input) => links.removeHostLifecycleForUser(input),
    status: Effect.fn("relay.host_lifecycle.status")(function* (input) {
      const response = yield* request({ ...input, operation: "status" });
      const decoded = yield* HttpClientResponse.schemaBodyJson(StatusBody)(response).pipe(
        Effect.mapError(
          (cause) =>
            new HostLifecycleRequestFailed({
              environmentId: input.environmentId,
              reason: "endpoint_response_invalid",
              cause,
            }),
        ),
      );
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        environmentId: input.environmentId as RelayEnvironmentHostStatusResponse["environmentId"],
        provider: "gcp",
        state: decoded.state,
        gceStatus: decoded.gceStatus,
        checkedAt,
      };
    }),
    wake: Effect.fn("relay.host_lifecycle.wake")(function* (input) {
      const response = yield* request({ ...input, operation: "wake" });
      const decoded = yield* HttpClientResponse.schemaBodyJson(WakeBody)(response).pipe(
        Effect.mapError(
          (cause) =>
            new HostLifecycleRequestFailed({
              environmentId: input.environmentId,
              reason: "endpoint_response_invalid",
              cause,
            }),
        ),
      );
      return {
        environmentId: input.environmentId as RelayEnvironmentWakeResponse["environmentId"],
        provider: "gcp",
        state: decoded.state,
        requestedAt: DateTime.formatIso(yield* DateTime.now),
      };
    }),
  });
});

export const layer = Layer.effect(HostLifecycle, make);

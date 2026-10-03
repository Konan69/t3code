import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as BoatClient from "../../boat/BoatClient.ts";
import { getBoatStatus, resumeBoatBox, stopBoatBox, setBoatBoxLifetime } from "./boat.ts";

const layer = BoatClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected HTTP request")),
    ),
  ),
  Layer.provide(DesktopConfig.layerTest({})),
);

describe("Boat IPC", () => {
  it.effect("returns NotConfigured through every registered method", () =>
    Effect.gen(function* () {
      const expected = { _tag: "NotConfigured", missing: ["BOAT_API_KEY", "CLOUDBOX_BOAT_NAME"] };
      expect(yield* getBoatStatus.handler(undefined)).toEqual(expected);
      expect(yield* resumeBoatBox.handler(undefined)).toEqual(expected);
      expect(yield* stopBoatBox.handler(undefined)).toEqual(expected);
      expect(yield* setBoatBoxLifetime.handler({ ttlSeconds: null })).toEqual(expected);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    undefined,
    {},
    { ttlSeconds: -1 },
    { ttlSeconds: 0 },
    { ttlSeconds: 1.5 },
    { ttlSeconds: "3600" },
    { ttlSeconds: Number.NaN },
    { ttlSeconds: Infinity },
  ])("resolves invalid lifetime input %j to RequestFailed", (input) =>
    Effect.gen(function* () {
      expect(yield* setBoatBoxLifetime.handler(input)).toEqual({
        _tag: "RequestFailed",
        message: "Boat request failed.",
      });
    }).pipe(Effect.provide(layer)),
  );
});

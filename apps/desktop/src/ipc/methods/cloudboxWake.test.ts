import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import { getCloudboxWakeConfig } from "./cloudboxWake.ts";

describe("getCloudboxWakeConfig", () => {
  it.effect("reads a complete wake policy from the desktop process environment", () =>
    Effect.gen(function* () {
      const result = yield* getCloudboxWakeConfig.handler(undefined);

      expect(result).toEqual({
        endpoint: "https://wake.example.test",
        name: "konan-dev",
        secret: "wake-secret",
        environmentId: "environment-1",
      });
    }).pipe(
      Effect.provide(
        DesktopConfig.layerTest({
          CLOUDBOX_WAKE_URL: " https://wake.example.test ",
          CLOUDBOX_WAKE_NAME: " konan-dev ",
          CLOUDBOX_WAKE_SECRET: " wake-secret ",
          CLOUDBOX_WAKE_ENVIRONMENT_ID: " environment-1 ",
        }),
      ),
    ),
  );

  it.effect("stays disabled when a required setting is missing", () =>
    Effect.gen(function* () {
      expect(yield* getCloudboxWakeConfig.handler(undefined)).toBeNull();
    }).pipe(
      Effect.provide(
        DesktopConfig.layerTest({
          CLOUDBOX_WAKE_URL: "https://wake.example.test",
          CLOUDBOX_WAKE_NAME: "konan-dev",
        }),
      ),
    ),
  );
});

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as HostMachineService from "./HostMachineService.ts";

export function shouldUseIncusMachineService(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    platform === "linux" &&
    Boolean(env.T3_MACHINE_IDENTITY_MANIFEST?.trim()) &&
    !env.WSL_DISTRO_NAME?.trim() &&
    !env.WSL_INTEROP?.trim()
  );
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    return shouldUseIncusMachineService(platform, environment)
      ? yield* Effect.promise(() => import("./IncusMachineService.ts")).pipe(
          Effect.map((module) => module.layer),
        )
      : HostMachineService.layer;
  }),
);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HostMachineService from "./HostMachineService.ts";

export function shouldUseIncusMachineService(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return platform === "linux" && !env.WSL_DISTRO_NAME?.trim() && !env.WSL_INTEROP?.trim();
}

export const layer = Layer.unwrap(
  shouldUseIncusMachineService(process.platform, process.env)
    ? Effect.promise(() => import("./IncusMachineService.ts")).pipe(
        Effect.map((module) => module.layer),
      )
    : Effect.succeed(HostMachineService.layer),
);

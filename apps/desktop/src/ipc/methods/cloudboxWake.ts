import { DesktopCloudboxWakeConfigSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getCloudboxWakeConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLOUDBOX_WAKE_CONFIG_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopCloudboxWakeConfigSchema),
  handler: Effect.fn("desktop.ipc.cloudboxWake.getConfig")(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    if (
      Option.isNone(config.cloudboxWakeEndpoint) ||
      Option.isNone(config.cloudboxWakeName) ||
      Option.isNone(config.cloudboxWakeSecret)
    ) {
      return null;
    }

    return {
      endpoint: config.cloudboxWakeEndpoint.value,
      name: config.cloudboxWakeName.value,
      secret: config.cloudboxWakeSecret.value,
      environmentId: Option.getOrNull(config.cloudboxWakeEnvironmentId),
    };
  }),
});

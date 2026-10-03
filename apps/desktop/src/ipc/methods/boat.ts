import { DesktopBoatStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BoatClient from "../../boat/BoatClient.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Payload decoding and result encoding failures must also resolve as status data.
const withStatusFailure = <E, R>(method: DesktopIpc.DesktopIpcMethod<E, R>) => ({
  ...method,
  handler: (raw: unknown) =>
    method.handler(raw).pipe(
      Effect.catchCause(() =>
        Effect.succeed({
          _tag: "RequestFailed" as const,
          message: "Boat request failed.",
        }),
      ),
    ),
});

export const getBoatStatus = withStatusFailure(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.GET_BOAT_STATUS_CHANNEL,
    payload: Schema.Void,
    result: DesktopBoatStatus,
    handler: Effect.fnUntraced(function* () {
      return yield* (yield* BoatClient.BoatClient).getBoatStatus();
    }),
  }),
);

export const resumeBoatBox = withStatusFailure(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.RESUME_BOAT_BOX_CHANNEL,
    payload: Schema.Void,
    result: DesktopBoatStatus,
    handler: Effect.fnUntraced(function* () {
      return yield* (yield* BoatClient.BoatClient).resumeBoatBox();
    }),
  }),
);

export const stopBoatBox = withStatusFailure(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.STOP_BOAT_BOX_CHANNEL,
    payload: Schema.Void,
    result: DesktopBoatStatus,
    handler: Effect.fnUntraced(function* () {
      return yield* (yield* BoatClient.BoatClient).stopBoatBox();
    }),
  }),
);

export const setBoatBoxLifetime = withStatusFailure(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.SET_BOAT_BOX_LIFETIME_CHANNEL,
    payload: Schema.Struct({
      ttlSeconds: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
    }),
    result: DesktopBoatStatus,
    handler: Effect.fnUntraced(function* (input) {
      return yield* (yield* BoatClient.BoatClient).setBoatBoxLifetime(input);
    }),
  }),
);

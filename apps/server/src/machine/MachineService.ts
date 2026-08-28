import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export const GOLDEN_IMAGE_ALIAS = "golden";
export const MACHINE_GUEST_USER = "kixey";
export const MACHINE_GUEST_WORKSPACE_ROOT = "/home/kixey/ws";
export const MACHINE_HOST_DATASET_ROOT = "/tank";

export const machineNameForThread = (threadId: ThreadId): string => `thread-${threadId}`;
export const hostWorkspaceRootForThread = (threadId: ThreadId): string =>
  `${MACHINE_HOST_DATASET_ROOT}/threads/${threadId}/ws`;

export const MachineState = Schema.Literals(["running", "stopped", "archived"]);
export type MachineState = typeof MachineState.Type;

export const ThreadMachineBinding = Schema.Struct({
  machineId: Schema.String,
  machineName: Schema.String,
  state: MachineState,
  hostWorkspaceRoot: Schema.String,
  guestWorkspaceRoot: Schema.String,
});
export type ThreadMachineBinding = typeof ThreadMachineBinding.Type;

export class MachineServiceError extends Schema.TaggedErrorClass<MachineServiceError>()(
  "MachineServiceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface MachineExecInput {
  readonly binding?: ThreadMachineBinding | undefined;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
  readonly shell?: boolean | string | undefined;
  readonly detached?: boolean | undefined;
  readonly forceKillAfter?: Duration.Input | undefined;
  readonly stdin?: ChildProcess.CommandInput | ChildProcess.StdinConfig | undefined;
  readonly stdout?: ChildProcess.CommandOutput | ChildProcess.StdoutConfig | undefined;
  readonly stderr?: ChildProcess.CommandOutput | ChildProcess.StderrConfig | undefined;
  readonly tty?: boolean | undefined;
}

export interface MachineServiceShape {
  readonly createFromGolden: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadMachineBinding>, MachineServiceError>;
  readonly start: (binding: ThreadMachineBinding) => Effect.Effect<void, MachineServiceError>;
  readonly stop: (binding: ThreadMachineBinding) => Effect.Effect<void, MachineServiceError>;
  readonly exec: (
    input: MachineExecInput,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, MachineServiceError, Scope.Scope>;
  readonly archive: (binding: ThreadMachineBinding) => Effect.Effect<void, MachineServiceError>;
  readonly destroy: (binding: ThreadMachineBinding) => Effect.Effect<void, MachineServiceError>;
  readonly hostToGuestPath: (
    binding: ThreadMachineBinding,
    hostPath: string,
  ) => Effect.Effect<string, MachineServiceError>;
  readonly guestToHostPath: (
    binding: ThreadMachineBinding,
    guestPath: string,
  ) => Effect.Effect<string, MachineServiceError>;
  readonly hostReachableUrl: (
    binding: ThreadMachineBinding,
    url: string,
  ) => Effect.Effect<string, MachineServiceError>;
}

export class MachineService extends Context.Service<MachineService, MachineServiceShape>()(
  "t3/machine/MachineService",
) {}

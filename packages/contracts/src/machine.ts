import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectMachineMode = Schema.Literals(["off", "thread"]);
export type ProjectMachineMode = typeof ProjectMachineMode.Type;

export const ThreadMachineState = Schema.Literals(["running", "stopped", "archived"]);
export type ThreadMachineState = typeof ThreadMachineState.Type;

export const ThreadMachineBinding = Schema.Struct({
  machineId: TrimmedNonEmptyString,
  machineName: TrimmedNonEmptyString,
  state: ThreadMachineState,
  projectWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  hostWorkspaceRoot: TrimmedNonEmptyString,
  guestWorkspaceRoot: TrimmedNonEmptyString,
});
export type ThreadMachineBinding = typeof ThreadMachineBinding.Type;

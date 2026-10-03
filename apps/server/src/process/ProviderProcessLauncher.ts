import type { ThreadId, ThreadMachineBinding } from "@t3tools/contracts";
import * as Context from "effect/Context";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProcessLauncherShape } from "./ProcessLauncher.ts";

/** Production supplies machine routing; adapter unit tests keep their host spawner. */
export class ProviderProcessLauncher extends Context.Reference<ProcessLauncherShape | undefined>(
  "t3/process/ProviderProcessLauncher",
  { defaultValue: () => undefined },
) {}

export function threadProcessSpawner(
  host: ChildProcessSpawner.ChildProcessSpawner["Service"],
  launcher: ProcessLauncherShape | undefined,
  threadId: ThreadId,
) {
  return launcher === undefined
    ? host
    : ChildProcessSpawner.make((command) =>
        command._tag === "PipedCommand"
          ? host.spawn(command)
          : launcher.launch({
              threadId,
              command: command.command,
              args: command.args,
              cwd: command.options.cwd,
              env: command.options.env,
              extendEnv: command.options.extendEnv,
              shell: command.options.shell,
              detached: command.options.detached,
              forceKillAfter: command.options.forceKillAfter,
              stdin: command.options.stdin,
              stdout: command.options.stdout,
              stderr: command.options.stderr,
            }),
      );
}

/** Provider RPCs use guest paths; Git and projection readers keep host paths. */
export function providerRuntimeCwd(policy: {
  readonly cwd: string | null;
  readonly machine?: ThreadMachineBinding | null | undefined;
}) {
  const { cwd, machine } = policy;
  if (!machine || cwd === null) return cwd;
  return cwd === machine.hostWorkspaceRoot
    ? machine.guestWorkspaceRoot
    : cwd.startsWith(`${machine.hostWorkspaceRoot}/`)
      ? `${machine.guestWorkspaceRoot}${cwd.slice(machine.hostWorkspaceRoot.length)}`
      : cwd;
}

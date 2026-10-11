/**
 * Fork: where a provider's child process is launched. The server routes a
 * thread that is bound to a thread machine into that machine; everything else
 * runs on the host. Provider packages reach it through this reference, so they
 * need no dependency on the server.
 */
import type { ThreadId, ThreadMachineBinding } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";

export interface ProcessLaunchInput {
  readonly threadId?: ThreadId | undefined;
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
}

export interface ProcessLauncherShape {
  readonly hostReachableUrl?: (input: {
    readonly threadId?: ThreadId;
    readonly url: string;
  }) => Effect.Effect<string, PlatformError.PlatformError>;
  /** Whether this thread's launches leave the host for a thread machine. */
  readonly runsInMachine?: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly launch: (
    input: ProcessLaunchInput,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  >;
}

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

/** False wherever no launcher is supplied, so tests and plain hosts are unaffected. */
export const runsInThreadMachine = (threadId: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const launcher = yield* ProviderProcessLauncher;
    return launcher?.runsInMachine === undefined
      ? false
      : yield* launcher.runsInMachine(threadId as ThreadId);
  });

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

import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  GOLDEN_IMAGE_ALIAS,
  MACHINE_GUEST_USER,
  MACHINE_GUEST_WORKSPACE_ROOT,
  MachineService,
  MachineServiceError,
  hostWorkspaceRootForThread,
  machineNameForThread,
  type MachineServiceShape,
  type ThreadMachineBinding,
} from "./MachineService.ts";
import type { ThreadId } from "@t3tools/contracts";

const INCUS_BINARY = "incus";
const ZFS_BINARY = "zfs";
const INCUS_STORAGE_POOL = "tank";
const WORKSPACE_DEVICE_NAME = "workspace";
const VM_AGENT_WAIT_LIMIT = "90 seconds";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const commandError = (operation: string, detail: string, cause?: unknown) =>
  new MachineServiceError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

const isMachineServiceError = Schema.is(MachineServiceError);

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const mappedPath = (
    operation: "hostToGuestPath" | "guestToHostPath",
    sourceRoot: string,
    targetRoot: string,
    sourcePath: string,
  ): Effect.Effect<string, MachineServiceError> => {
    const normalizedRoot = path.resolve(sourceRoot);
    const normalizedPath = path.resolve(sourcePath);
    const relative = path.relative(normalizedRoot, normalizedPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return Effect.fail(
        commandError(
          operation,
          `Path '${sourcePath}' is outside machine workspace '${sourceRoot}'.`,
        ),
      );
    }
    return Effect.succeed(path.join(targetRoot, relative));
  };

  const runCommand = Effect.fn("IncusMachineService.runCommand")(
    (operation: string, command: string, args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command, args, {
              stdin: "ignore",
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              commandError(operation, `Failed to spawn '${command} ${args.join(" ")}'.`, cause),
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError((cause) =>
            commandError(operation, `Failed while running '${command} ${args.join(" ")}'.`, cause),
          ),
        );
        return { code: Number(exitCode), stdout, stderr } satisfies CommandResult;
      }).pipe(Effect.scoped),
  );

  const runChecked = Effect.fn("IncusMachineService.runChecked")(function* (
    operation: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runCommand(operation, command, args);
    if (result.code !== 0) {
      return yield* commandError(
        operation,
        `'${command} ${args.join(" ")}' exited with ${result.code}: ${result.stderr.trim()}`,
      );
    }
    return result;
  });

  const inspect = Effect.fn("IncusMachineService.inspect")(function* (machineName: string) {
    const result = yield* runChecked("inspect", INCUS_BINARY, [
      "list",
      machineName,
      "--format=json",
    ]);
    const rows = yield* Effect.try({
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      try: () => JSON.parse(result.stdout) as ReadonlyArray<{ name?: string; status?: string }>,
      catch: (cause) =>
        commandError("inspect", `Incus returned invalid JSON for '${machineName}'.`, cause),
    });
    const row = rows.find((entry) => entry.name === machineName) ?? rows[0];
    return row
      ? Option.some({ status: row.status?.toLowerCase() ?? "unknown" })
      : Option.none<{ readonly status: string }>();
  });

  const ensureDataset = Effect.fn("IncusMachineService.ensureDataset")(function* (
    threadId: ThreadId,
  ) {
    const dataset = `${INCUS_STORAGE_POOL}/threads/${threadId}/ws`;
    const listed = yield* runCommand("dataset.inspect", ZFS_BINARY, [
      "list",
      "-H",
      "-o",
      "name",
      dataset,
    ]);
    if (listed.code !== 0) {
      yield* runChecked("dataset.create", ZFS_BINARY, ["create", "-p", dataset]);
    }
  });

  const ensureWorkspaceDevice = Effect.fn("IncusMachineService.ensureWorkspaceDevice")(function* (
    binding: ThreadMachineBinding,
  ) {
    const result = yield* runCommand("device.inspect", INCUS_BINARY, [
      "config",
      "device",
      "get",
      binding.machineName,
      WORKSPACE_DEVICE_NAME,
      "source",
    ]);
    if (result.code === 0) {
      return;
    }
    yield* runChecked("device.add", INCUS_BINARY, [
      "config",
      "device",
      "add",
      binding.machineName,
      WORKSPACE_DEVICE_NAME,
      "disk",
      `source=${binding.hostWorkspaceRoot}`,
      `path=${binding.guestWorkspaceRoot}`,
      "shift=true",
    ]);
  });

  const waitForAgent = (binding: ThreadMachineBinding) =>
    runChecked("agent.wait", INCUS_BINARY, ["exec", binding.machineName, "--", "true"]).pipe(
      Effect.retry({
        schedule: Schedule.spaced("500 millis").pipe(
          Schedule.upTo({ duration: VM_AGENT_WAIT_LIMIT }),
        ),
      }),
      Effect.asVoid,
    );

  const start: MachineServiceShape["start"] = Effect.fn("IncusMachineService.start")(
    function* (binding) {
      const current = yield* inspect(binding.machineName);
      if (Option.isNone(current)) {
        return yield* commandError("start", `Machine '${binding.machineName}' does not exist.`);
      }
      if (current.value.status !== "running") {
        yield* runChecked("start", INCUS_BINARY, ["start", binding.machineName]);
      }
      yield* waitForAgent(binding);
    },
  );

  const createFromGolden: MachineServiceShape["createFromGolden"] = Effect.fn(
    "IncusMachineService.createFromGolden",
  )(function* (threadId) {
    const machineName = machineNameForThread(threadId);
    const binding = {
      machineId: machineName,
      machineName,
      state: "running",
      hostWorkspaceRoot: hostWorkspaceRootForThread(threadId),
      guestWorkspaceRoot: MACHINE_GUEST_WORKSPACE_ROOT,
    } satisfies ThreadMachineBinding;

    yield* ensureDataset(threadId);
    const current = yield* inspect(machineName);
    if (Option.isNone(current)) {
      yield* runChecked("copy", INCUS_BINARY, ["copy", GOLDEN_IMAGE_ALIAS, machineName]);
    }
    yield* ensureWorkspaceDevice(binding);
    yield* start(binding);
    return Option.some(binding);
  });

  const stop: MachineServiceShape["stop"] = Effect.fn("IncusMachineService.stop")(
    function* (binding) {
      const current = yield* inspect(binding.machineName);
      if (Option.isSome(current) && current.value.status === "running") {
        yield* runChecked("stop", INCUS_BINARY, ["stop", binding.machineName, "--force"]);
      }
    },
  );

  const exec: MachineServiceShape["exec"] = (input) => {
    if (input.binding === undefined) {
      return spawner
        .spawn(
          ChildProcess.make(input.command, input.args, {
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.extendEnv !== undefined ? { extendEnv: input.extendEnv } : {}),
            ...(input.shell !== undefined ? { shell: input.shell } : {}),
            ...(input.detached !== undefined ? { detached: input.detached } : {}),
            ...(input.forceKillAfter !== undefined ? { forceKillAfter: input.forceKillAfter } : {}),
            ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
            ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
            ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            commandError("exec", `Failed to spawn host process '${input.command}'.`, cause),
          ),
        );
    }
    if (input.shell !== undefined && input.shell !== false) {
      return Effect.fail(
        commandError("exec", "Machine execution does not accept host shell launch specifications."),
      );
    }

    return Effect.gen(function* () {
      const binding = input.binding!;
      const cwd = input.cwd
        ? yield* mappedPath(
            "hostToGuestPath",
            binding.hostWorkspaceRoot,
            binding.guestWorkspaceRoot,
            input.cwd,
          )
        : binding.guestWorkspaceRoot;
      const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : ["--env", `${key}=${value}`],
      );
      return yield* spawner.spawn(
        ChildProcess.make(
          INCUS_BINARY,
          [
            "exec",
            binding.machineName,
            "--user",
            MACHINE_GUEST_USER,
            "--cwd",
            cwd,
            ...envArgs,
            "--",
            input.command,
            ...input.args,
          ],
          {
            stdin: input.stdin ?? "ignore",
            ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
            ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
            ...(input.forceKillAfter !== undefined ? { forceKillAfter: input.forceKillAfter } : {}),
          },
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isMachineServiceError(cause)
          ? cause
          : commandError("exec", `Failed to execute '${input.command}' in machine.`, cause),
      ),
    );
  };

  const archive: MachineServiceShape["archive"] = (binding) => stop(binding);

  const destroy: MachineServiceShape["destroy"] = Effect.fn("IncusMachineService.destroy")(
    function* (binding) {
      const current = yield* inspect(binding.machineName);
      if (Option.isSome(current)) {
        yield* runChecked("destroy", INCUS_BINARY, ["delete", binding.machineName, "--force"]);
      }
    },
  );

  const hostReachableUrl: MachineServiceShape["hostReachableUrl"] = Effect.fn(
    "IncusMachineService.hostReachableUrl",
  )(function* (binding, value) {
    const url = new URL(value);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return value;
    }
    const result = yield* runChecked("network.inspect", INCUS_BINARY, [
      "list",
      binding.machineName,
      "--format=json",
    ]);
    const rows = yield* Effect.try({
      try: () =>
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.parse(result.stdout) as ReadonlyArray<{
          state?: { network?: Record<string, { addresses?: ReadonlyArray<{ address?: string }> }> };
        }>,
      catch: (cause) =>
        commandError("network.inspect", "Incus returned invalid network JSON.", cause),
    });
    const address = Object.values(rows[0]?.state?.network ?? {})
      .flatMap((network) => network.addresses ?? [])
      .map((entry) => entry.address)
      .find((entry) => entry?.includes(".") === true);
    if (!address) {
      return yield* commandError(
        "network.inspect",
        `Machine '${binding.machineName}' has no IPv4 address.`,
      );
    }
    url.hostname = address;
    return url.toString();
  });

  return MachineService.of({
    createFromGolden,
    start,
    stop,
    exec,
    archive,
    destroy,
    hostToGuestPath: (binding, hostPath) =>
      mappedPath(
        "hostToGuestPath",
        binding.hostWorkspaceRoot,
        binding.guestWorkspaceRoot,
        hostPath,
      ),
    guestToHostPath: (binding, guestPath) =>
      mappedPath(
        "guestToHostPath",
        binding.guestWorkspaceRoot,
        binding.hostWorkspaceRoot,
        guestPath,
      ),
    hostReachableUrl,
  });
});

export const layer = Layer.effect(MachineService, make);

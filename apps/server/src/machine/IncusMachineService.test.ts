import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as IncusMachineService from "./IncusMachineService.ts";
import { MachineService, type ThreadMachineBinding } from "./MachineService.ts";

function makeHandle(input: {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}) {
  const bytes = (value: string) => Stream.make(new TextEncoder().encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout ?? ""),
    stderr: bytes(input.stderr ?? ""),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const EMPTY_IDENTITY_MANIFEST = JSON.stringify({ version: 1, mounts: [] });

interface TestIdentityManifestOptions {
  readonly contents?: string;
  readonly state?: "present" | "missing-file" | "relative-path" | "unset";
}

const provideIncus = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  manifestOptions: TestIdentityManifestOptions = {},
) => {
  const serverConfigLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      if (manifestOptions.state === "unset") {
        return ServerConfig.make({ ...config, machineIdentityManifest: undefined });
      }
      if (manifestOptions.state === "relative-path") {
        return ServerConfig.make({ ...config, machineIdentityManifest: "identity.json" });
      }

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const manifestPath = path.join(config.baseDir, "machine-identity.json");
      if (manifestOptions.state !== "missing-file") {
        yield* fileSystem.writeFileString(
          manifestPath,
          manifestOptions.contents ?? EMPTY_IDENTITY_MANIFEST,
        );
      }
      return ServerConfig.make({ ...config, machineIdentityManifest: manifestPath });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest("/repo", { prefix: "incus-machine-test" })));

  return Layer.effect(
    MachineService,
    IncusMachineService.make({ uid: 1001, gid: 1002 }, { mcpPort: 3773 }),
  ).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(serverConfigLayer),
    Layer.provide(NodeServices.layer),
  );
};

function makeMachineSpawner(
  initialDevices: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
) {
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const devices = new Map(
    Object.entries(initialDevices).map(([name, config]) => [name, new Map(Object.entries(config))]),
  );
  let machineExists = false;
  let running = false;
  const spawner = ChildProcessSpawner.make((input) => {
    const command = input as unknown as { command: string; args: ReadonlyArray<string> };
    commands.push({ command: command.command, args: command.args });
    const args = command.args;
    const zfsArgs =
      command.command === "sudo" && args[0] === "-n" && args[1] === "zfs"
        ? args.slice(2)
        : undefined;
    if (zfsArgs?.[0] === "list") {
      return Effect.succeed(makeHandle({}));
    }
    if (zfsArgs?.[0] === "get") {
      return Effect.succeed(makeHandle({ stdout: "/tank/threads/thread-1/ws\n" }));
    }
    if (args.slice(0, 2).join(" ") === "image list") {
      return Effect.succeed(makeHandle({ stdout: '[{"type":"container"}]' }));
    }
    if (args[0] === "list") {
      return Effect.succeed(
        makeHandle({
          stdout: machineExists
            ? `[{"name":"thread-thread-1","status":"${running ? "Running" : "Stopped"}"}]`
            : "[]",
        }),
      );
    }
    if (args[0] === "init") {
      machineExists = true;
      return Effect.succeed(makeHandle({}));
    }
    if (args.slice(0, 3).join(" ") === "config device list") {
      return Effect.succeed(makeHandle({ stdout: `${[...devices.keys()].join("\n")}\n` }));
    }
    if (args.slice(0, 3).join(" ") === "config device get") {
      const config = devices.get(args[4] ?? "");
      return Effect.succeed(
        makeHandle({
          code: config ? 0 : 1,
          stdout: config ? `${config.get(args[5] ?? "") ?? ""}\n` : "",
        }),
      );
    }
    if (args.slice(0, 3).join(" ") === "config device add") {
      const config = new Map<string, string>();
      for (const option of args.slice(6)) {
        const separator = option.indexOf("=");
        if (separator >= 0) {
          config.set(option.slice(0, separator), option.slice(separator + 1));
        }
      }
      devices.set(args[4] ?? "", config);
      return Effect.succeed(makeHandle({}));
    }
    if (args.slice(0, 3).join(" ") === "config device set") {
      const config = devices.get(args[4] ?? "") ?? new Map<string, string>();
      for (const option of args.slice(5)) {
        const separator = option.indexOf("=");
        if (separator >= 0) {
          config.set(option.slice(0, separator), option.slice(separator + 1));
        }
      }
      devices.set(args[4] ?? "", config);
      return Effect.succeed(makeHandle({}));
    }
    if (args.slice(0, 3).join(" ") === "config device remove") {
      devices.delete(args[4] ?? "");
      return Effect.succeed(makeHandle({}));
    }
    if (args[0] === "start") {
      running = true;
    }
    return Effect.succeed(makeHandle({}));
  });

  return { commands, devices, spawner };
}

describe("IncusMachineService", () => {
  it("builds explicit root and non-root ZFS command specifications", () => {
    expect(IncusMachineService.zfsCommand(["list", "tank/threads"], 0)).toEqual({
      command: "zfs",
      args: ["list", "tank/threads"],
    });
    expect(IncusMachineService.zfsCommand(["list", "tank/threads"], 1000)).toEqual({
      command: "sudo",
      args: ["-n", "zfs", "list", "tank/threads"],
    });
  });

  it("resolves provider binaries by name and exposes OpenCode outside guest loopback", () => {
    expect(IncusMachineService.guestProviderBinary("/home/kixey/.local/share/pnpm/codex")).toBe(
      "codex",
    );
    expect(IncusMachineService.guestProviderBinary("C:\\tools\\pi.cmd")).toBe("pi");
    expect(
      IncusMachineService.guestProviderArgs("/host/bin/opencode", [
        "serve",
        "--hostname=127.0.0.1",
      ]),
    ).toEqual(["serve", "--hostname=0.0.0.0"]);
  });

  it.effect("fails machine creation when the identity manifest is not configured", () => {
    const { commands, spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest");
      expect(error.detail).toContain("T3_MACHINE_IDENTITY_MANIFEST");
      expect(
        commands.some(
          (entry) =>
            entry.args.slice(0, 3).join(" ") === "config device add" &&
            entry.args[4]?.startsWith("identity-") === true,
        ),
      ).toBe(false);
    }).pipe(Effect.provide(provideIncus(spawner, { state: "unset" })));
  });

  it.effect("fails machine creation when the identity manifest file is missing", () => {
    const { spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest.read");
      expect(error.detail).toContain("Could not read identity manifest");
    }).pipe(Effect.provide(provideIncus(spawner, { state: "missing-file" })));
  });

  it.effect("requires an absolute identity manifest path", () => {
    const { spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest");
      expect(error.detail).toContain("must be absolute");
    }).pipe(Effect.provide(provideIncus(spawner, { state: "relative-path" })));
  });

  it.effect("strictly rejects invalid identity manifests", () => {
    const { spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest.parse");
      expect(error.detail).toContain("is invalid");
    }).pipe(
      Effect.provide(
        provideIncus(spawner, {
          contents: JSON.stringify({
            version: 1,
            mounts: [
              {
                hostPath: process.cwd(),
                guestPath: "/home/kixey/.codex",
                readOnly: false,
                unexpected: true,
              },
            ],
          }),
        }),
      ),
    );
  });

  it.effect("requires absolute host and guest identity paths", () => {
    const { spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest.validate");
      expect(error.detail).toContain("absolute hostPath and guestPath");
    }).pipe(
      Effect.provide(
        provideIncus(spawner, {
          contents: JSON.stringify({
            version: 1,
            mounts: [
              {
                hostPath: process.cwd(),
                guestPath: "home/kixey/.codex",
                readOnly: false,
              },
            ],
          }),
        }),
      ),
    );
  });

  it.effect("rejects identity host paths that are not directories", () => {
    const { spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest.validate");
      expect(error.detail).toContain("is not an existing directory");
    }).pipe(
      Effect.provide(
        provideIncus(spawner, {
          contents: JSON.stringify({
            version: 1,
            mounts: [
              {
                hostPath: `${process.cwd()}/apps/server/package.json`,
                guestPath: "/home/kixey/.codex",
                readOnly: false,
              },
            ],
          }),
        }),
      ),
    );
  });

  it.effect("validates every identity host directory before mounting any of them", () => {
    const { commands, spawner } = makeMachineSpawner();

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.createFromGolden(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("identity.manifest.validate");
      expect(error.detail).toContain("is not an existing directory");
      expect(
        commands.some((entry) => entry.args.slice(0, 3).join(" ") === "config device list"),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        provideIncus(spawner, {
          contents: JSON.stringify({
            version: 1,
            mounts: [
              {
                hostPath: process.cwd(),
                guestPath: "/home/kixey/.codex",
                readOnly: false,
              },
              {
                hostPath: "/definitely/missing/t3-machine-identity",
                guestPath: "/home/kixey/.pi",
                readOnly: false,
              },
            ],
          }),
        }),
      ),
    );
  });

  it.effect("adds, updates, and removes identity devices from a valid manifest", () => {
    const { commands, devices, spawner } = makeMachineSpawner({
      "identity-0-codex": {
        source: "/old/codex",
        path: "/old/guest-codex",
        shift: "false",
        readonly: "true",
      },
      "identity-9-old": {
        source: "/old/removed",
        path: "/home/kixey/.removed",
        shift: "true",
        readonly: "false",
      },
    });
    const manifest = {
      version: 1,
      mounts: [
        {
          hostPath: process.cwd(),
          guestPath: "/home/kixey/.codex",
          readOnly: false,
        },
        {
          hostPath: `${process.cwd()}/apps/server`,
          guestPath: "/home/kixey/.pi",
          readOnly: true,
        },
      ],
    };

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      yield* machines.createFromGolden(ThreadId.make("thread-1"));

      expect(Object.fromEntries(devices.get("identity-0-codex") ?? [])).toEqual({
        source: process.cwd(),
        path: "/home/kixey/.codex",
        shift: "true",
        readonly: "false",
      });
      expect(Object.fromEntries(devices.get("identity-1-pi") ?? [])).toEqual({
        source: `${process.cwd()}/apps/server`,
        path: "/home/kixey/.pi",
        shift: "true",
        readonly: "true",
      });
      expect(devices.has("identity-9-old")).toBe(false);
      expect(commands).toContainEqual({
        command: "incus",
        args: ["config", "device", "remove", "thread-thread-1", "identity-9-old"],
      });

      const mutationCount = commands.filter(
        (entry) =>
          ["add", "set", "remove"].includes(entry.args[2] ?? "") &&
          entry.args[4]?.startsWith("identity-") === true,
      ).length;
      yield* machines.createFromGolden(ThreadId.make("thread-1"));
      expect(
        commands.filter(
          (entry) =>
            ["add", "set", "remove"].includes(entry.args[2] ?? "") &&
            entry.args[4]?.startsWith("identity-") === true,
        ),
      ).toHaveLength(mutationCount);
    }).pipe(
      Effect.provide(provideIncus(spawner, { contents: JSON.stringify(manifest) })),
      TestClock.withLive,
    );
  });

  it.effect("surfaces sudo failures without retrying plain zfs", () => {
    const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as { command: string; args: ReadonlyArray<string> };
      commands.push({ command: command.command, args: command.args });
      return Effect.succeed(makeHandle({ code: 1, stderr: "sudo: a password is required" }));
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.ensureWorkspace(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("dataset.inspect");
      expect(error.detail).toContain("sudo -n zfs list");
      expect(commands).toEqual([
        {
          command: "sudo",
          args: ["-n", "zfs", "list", "-H", "-o", "name", "tank/threads/thread-1/ws"],
        },
      ]);
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect("rejects a dataset mounted somewhere other than its workspace path", () => {
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as { args: ReadonlyArray<string> };
      const zfsArgs = command.args.slice(2);
      return Effect.succeed(
        zfsArgs[0] === "get" ? makeHandle({ stdout: "/wrong/path\n" }) : makeHandle({}),
      );
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.ensureWorkspace(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("dataset.mountpoint");
      expect(error.detail).toContain("expected '/tank/threads/thread-1/ws'");
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect(
    "creates from golden idempotently, mounts the dataset, starts, and waits for the agent",
    () => {
      const commands: Array<{ command: string; args: ReadonlyArray<string>; stdin?: unknown }> = [];
      let datasetExists = false;
      let machineExists = false;
      const devices = new Map<string, Map<string, string>>();
      let running = false;
      let agentAttempts = 0;
      const spawner = ChildProcessSpawner.make((input) => {
        const command = input as unknown as {
          command: string;
          args: ReadonlyArray<string>;
          options: { stdin?: unknown };
        };
        commands.push({
          command: command.command,
          args: command.args,
          stdin: command.options.stdin,
        });
        const args = command.args;
        const zfsArgs =
          command.command === "sudo" && args[0] === "-n" && args[1] === "zfs"
            ? args.slice(2)
            : undefined;
        if (zfsArgs?.[0] === "list") {
          return Effect.succeed(
            makeHandle({
              code: datasetExists ? 0 : 1,
              stderr: datasetExists ? "" : "cannot open dataset: dataset does not exist",
            }),
          );
        }
        if (zfsArgs?.[0] === "create") {
          datasetExists = true;
          return Effect.succeed(makeHandle({}));
        }
        if (zfsArgs?.[0] === "get") {
          return Effect.succeed(makeHandle({ stdout: "/tank/threads/thread-1/ws\n" }));
        }
        if (args.slice(0, 2).join(" ") === "image list") {
          return Effect.succeed(makeHandle({ stdout: '[{"type":"container"}]' }));
        }
        if (args[0] === "list") {
          return Effect.succeed(
            makeHandle({
              stdout: machineExists
                ? `[{"name":"thread-thread-1","status":"${running ? "Running" : "Stopped"}"}]`
                : "[]",
            }),
          );
        }
        if (args[0] === "init") {
          machineExists = true;
          return Effect.succeed(makeHandle({}));
        }
        if (args.slice(0, 3).join(" ") === "config device get") {
          const config = devices.get(args[4] ?? "");
          return Effect.succeed(
            makeHandle({
              code: config ? 0 : 1,
              stdout: config ? `${config.get(args[5] ?? "") ?? ""}\n` : "",
            }),
          );
        }
        if (args.slice(0, 3).join(" ") === "config device add") {
          const config = new Map<string, string>();
          for (const option of args.slice(6)) {
            const separator = option.indexOf("=");
            if (separator >= 0) {
              config.set(option.slice(0, separator), option.slice(separator + 1));
            }
          }
          devices.set(args[4] ?? "", config);
          return Effect.succeed(makeHandle({}));
        }
        if (args.slice(0, 3).join(" ") === "config device set") {
          const config = devices.get(args[4] ?? "") ?? new Map<string, string>();
          for (const option of args.slice(5)) {
            const separator = option.indexOf("=");
            if (separator >= 0) {
              config.set(option.slice(0, separator), option.slice(separator + 1));
            }
          }
          devices.set(args[4] ?? "", config);
          return Effect.succeed(makeHandle({}));
        }
        if (args[0] === "start") {
          running = true;
          return Effect.succeed(makeHandle({}));
        }
        if (args[0] === "exec") {
          agentAttempts += 1;
          return Effect.succeed(makeHandle({ code: agentAttempts === 1 ? 1 : 0 }));
        }
        return Effect.succeed(makeHandle({}));
      });

      return Effect.gen(function* () {
        const machines = yield* MachineService;
        yield* machines.ensureWorkspace(ThreadId.make("thread-1"));
        const first = yield* machines.createFromGolden(ThreadId.make("thread-1"));
        const second = yield* machines.createFromGolden(ThreadId.make("thread-1"));

        expect(Option.getOrThrow(first)).toEqual({
          machineId: "thread-thread-1",
          machineName: "thread-thread-1",
          state: "running",
          hostWorkspaceRoot: "/tank/threads/thread-1/ws",
          guestWorkspaceRoot: "/home/kixey/ws",
        });
        expect(Option.getOrThrow(second)).toEqual(Option.getOrThrow(first));
        expect(commands.filter((entry) => entry.args[0] === "copy")).toHaveLength(0);
        expect(commands.filter((entry) => entry.args[0] === "init")).toHaveLength(1);
        expect(commands).toContainEqual({
          command: "incus",
          args: ["init", "golden", "thread-thread-1", "-c", "security.nesting=true"],
          stdin: "ignore",
        });
        expect(commands.filter((entry) => entry.args[0] === "start")).toHaveLength(1);
        expect(commands).toContainEqual({
          command: "sudo",
          args: [
            "-n",
            "zfs",
            "create",
            "-p",
            "-o",
            "mountpoint=/tank/threads/thread-1/ws",
            "tank/threads/thread-1/ws",
          ],
          stdin: "ignore",
        });
        expect(commands).toContainEqual({
          command: "sudo",
          args: ["-n", "zfs", "get", "-H", "-o", "value", "mountpoint", "tank/threads/thread-1/ws"],
          stdin: "ignore",
        });
        expect(commands).toContainEqual({
          command: "sudo",
          args: ["-n", "chown", "1001:1002", "/tank/threads/thread-1/ws"],
          stdin: "ignore",
        });
        expect(commands.some((entry) => entry.command === "zfs")).toBe(false);
        expect(
          commands.filter((entry) => entry.args.slice(0, 3).join(" ") === "config device add"),
        ).toHaveLength(3);
        expect(commands).toContainEqual({
          command: "incus",
          args: [
            "config",
            "device",
            "add",
            "thread-thread-1",
            "workspace",
            "disk",
            "source=/tank/threads/thread-1/ws",
            "path=/home/kixey/ws",
            "shift=true",
          ],
          stdin: "ignore",
        });
        expect(commands).toContainEqual({
          command: "incus",
          args: [
            "config",
            "device",
            "add",
            "thread-thread-1",
            "t3-mcp",
            "proxy",
            "listen=tcp:127.0.0.1:3773",
            "connect=tcp:127.0.0.1:3773",
            "bind=instance",
          ],
          stdin: "ignore",
        });
        const attachments = commands.find(
          (entry) =>
            entry.args.slice(0, 3).join(" ") === "config device add" &&
            entry.args[4] === "attachments",
        );
        expect(attachments?.args[5]).toBe("disk");
        expect(attachments?.args).toContain("readonly=true");
        expect(attachments?.args).toContain("shift=true");
        const attachmentSource = attachments?.args.find((arg) => arg.startsWith("source="));
        expect(attachments?.args).toContain(attachmentSource?.replace("source=", "path="));
        expect(
          commands
            .filter((entry) => entry.command === "incus")
            .every((entry) => entry.stdin === "ignore"),
        ).toBe(true);
        expect(commands.filter((entry) => entry.args[0] === "exec")).toHaveLength(3);
      }).pipe(Effect.provide(provideIncus(spawner)), TestClock.withLive);
    },
  );

  it.effect("initializes VM images with --vm and destroys the instance before its dataset", () => {
    const commands: Array<{ command: string; args: ReadonlyArray<string>; stdin?: unknown }> = [];
    let machineExists = false;
    let running = false;
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options: { stdin?: unknown };
      };
      commands.push({ command: command.command, args: command.args, stdin: command.options.stdin });
      const args = command.args;
      const zfsArgs =
        command.command === "sudo" && args[0] === "-n" && args[1] === "zfs"
          ? args.slice(2)
          : undefined;
      if (zfsArgs?.[0] === "list" || zfsArgs?.[0] === "destroy") {
        return Effect.succeed(makeHandle({}));
      }
      if (zfsArgs?.[0] === "get") {
        return Effect.succeed(makeHandle({ stdout: "/tank/threads/thread-1/ws\n" }));
      }
      if (args.slice(0, 2).join(" ") === "image list") {
        return Effect.succeed(makeHandle({ stdout: '[{"type":"virtual-machine"}]' }));
      }
      if (args[0] === "list") {
        return Effect.succeed(
          makeHandle({
            stdout: machineExists
              ? `[{"name":"thread-thread-1","status":"${running ? "Running" : "Stopped"}"}]`
              : "[]",
          }),
        );
      }
      if (args[0] === "init") {
        machineExists = true;
        return Effect.succeed(makeHandle({}));
      }
      if (args.slice(0, 3).join(" ") === "config device get") {
        return Effect.succeed(makeHandle({ code: 1 }));
      }
      if (args[0] === "start") {
        running = true;
      }
      if (args[0] === "delete") {
        machineExists = false;
      }
      return Effect.succeed(makeHandle({}));
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const created = Option.getOrThrow(
        yield* machines.createFromGolden(ThreadId.make("thread-1")),
      );
      yield* machines.destroy(created);

      expect(commands).toContainEqual({
        command: "incus",
        args: ["init", "golden", "thread-thread-1", "--vm"],
        stdin: "ignore",
      });
      expect(commands.some((entry) => entry.args.includes("security.nesting=true"))).toBe(false);
      const deleteIndex = commands.findIndex((entry) => entry.args[0] === "delete");
      const datasetDestroyIndex = commands.findIndex(
        (entry) =>
          entry.command === "sudo" &&
          entry.args.join(" ") === "-n zfs destroy -r tank/threads/thread-1",
      );
      expect(deleteIndex).toBeGreaterThanOrEqual(0);
      expect(datasetDestroyIndex).toBeGreaterThan(deleteIndex);
      expect(commands[datasetDestroyIndex]).toEqual({
        command: "sudo",
        args: ["-n", "zfs", "destroy", "-r", "tank/threads/thread-1"],
        stdin: "ignore",
      });
      expect(
        commands
          .filter((entry) => entry.command === "incus")
          .every((entry) => entry.stdin === "ignore"),
      ).toBe(true);
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect("destroys the thread parent dataset instead of only its workspace child", () => {
    const { commands, spawner } = makeMachineSpawner();
    const binding = {
      machineId: "thread-thread-1",
      machineName: "thread-thread-1",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/thread-1/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      yield* machines.destroy(binding);

      expect(commands).toContainEqual({
        command: "sudo",
        args: ["-n", "zfs", "list", "-H", "-o", "name", "tank/threads/thread-1"],
      });
      expect(commands).toContainEqual({
        command: "sudo",
        args: ["-n", "zfs", "destroy", "-r", "tank/threads/thread-1"],
      });
      expect(commands).not.toContainEqual({
        command: "sudo",
        args: ["-n", "zfs", "destroy", "-r", "tank/threads/thread-1/ws"],
      });
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect("refuses to destroy a dataset outside the per-thread parent shape", () => {
    const { commands, spawner } = makeMachineSpawner();
    const binding = {
      machineId: "thread-thread-1",
      machineName: "thread-thread-1",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.destroy(binding).pipe(Effect.flip);

      expect(error.operation).toBe("dataset.destroy");
      expect(error.detail).toContain("expected exactly 'tank/threads/<thread id>'");
      expect(
        commands.some(
          (entry) =>
            entry.command === "sudo" && entry.args.slice(0, 3).join(" ") === "-n zfs destroy",
        ),
      ).toBe(false);
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect("maps cwd and launches with cached guest ids and piped stdio", () => {
    let captured: unknown;
    let guestIdLookups = 0;
    const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as {
        command: string;
        args: ReadonlyArray<string>;
      };
      commands.push({ command: command.command, args: command.args });
      if (command.args[0] === "list") {
        return Effect.succeed(
          makeHandle({ stdout: '[{"name":"thread-thread-1","status":"Running"}]' }),
        );
      }
      if (command.args.slice(0, 3).join(" ") === "config device get") {
        return Effect.succeed(makeHandle({ code: 1 }));
      }
      if (command.args.includes("getent")) {
        guestIdLookups += 1;
        return Effect.succeed(makeHandle({ stdout: "kixey:x:1000:1000::/home/kixey:/bin/bash\n" }));
      }
      if (command.args.includes("codex")) {
        captured = input;
      }
      return Effect.succeed(makeHandle({}));
    });
    const binding = {
      machineId: "thread-thread-1",
      machineName: "thread-thread-1",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/thread-1/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      yield* machines.exec({
        binding,
        command: "codex",
        args: ["app-server", "--flag=value"],
        cwd: "/tank/threads/thread-1/ws/packages/app",
        env: { TOKEN: "secret" },
      });
      expect(captured).toMatchObject({
        command: "incus",
        args: [
          "exec",
          "thread-thread-1",
          "--user",
          "1000",
          "--group",
          "1000",
          "--cwd",
          "/home/kixey/ws/packages/app",
          "--env",
          "TOKEN=secret",
          "--",
          "codex",
          "app-server",
          "--flag=value",
        ],
      });
      expect(
        (captured as { options?: { stdin?: unknown } } | undefined)?.options?.stdin,
      ).toBeUndefined();

      yield* machines.exec({
        binding,
        command: "/host/bin/codex",
        args: ["app-server"],
        cwd: binding.hostWorkspaceRoot,
        env: {
          HOME: "/host/home",
          PATH: "/host/bin",
          WORKSPACE: binding.hostWorkspaceRoot,
        },
        extendEnv: true,
        detached: true,
      });
      expect(guestIdLookups).toBe(1);
      const second = captured as
        | { args: ReadonlyArray<string>; options?: { detached?: boolean } }
        | undefined;
      expect(second?.options?.detached).toBe(true);
      expect(second?.args).toContain("--env");
      expect(second?.args).toContain("HOME=/home/kixey");
      expect(second?.args).toContain(
        "PATH=/home/kixey/.local/bin:/home/kixey/.local/share/pnpm:/home/kixey/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      );
      expect(second?.args).toContain("WORKSPACE=/home/kixey/ws");
      expect(second?.args.at(second.args.lastIndexOf("--") + 1)).toBe("codex");
      expect(second?.args).not.toContain("/host/bin/codex");
      expect(
        commands.filter((entry) => entry.args.slice(0, 3).join(" ") === "config device list"),
      ).toHaveLength(2);
      expect(commands).toContainEqual({
        command: "incus",
        args: [
          "config",
          "device",
          "add",
          "thread-thread-1",
          "t3-mcp",
          "proxy",
          "listen=tcp:127.0.0.1:3773",
          "connect=tcp:127.0.0.1:3773",
          "bind=instance",
        ],
      });

      const escaped = yield* machines
        .hostToGuestPath(binding, "/tank/threads/other/ws")
        .pipe(Effect.exit);
      expect(escaped._tag).toBe("Failure");
    }).pipe(Effect.provide(provideIncus(spawner)), Effect.scoped);
  });

  it.effect("rewrites guest listener URLs to a non-loopback machine address", () => {
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as { args: ReadonlyArray<string> };
      if (command.args[0] === "list") {
        return Effect.succeed(
          makeHandle({
            stdout: JSON.stringify([
              {
                name: "thread-thread-1",
                state: {
                  network: {
                    lo: { addresses: [{ address: "127.0.0.1" }] },
                    eth0: { addresses: [{ address: "10.42.0.18" }] },
                  },
                },
              },
            ]),
          }),
        );
      }
      return Effect.succeed(makeHandle({}));
    });
    const binding = {
      machineId: "thread-thread-1",
      machineName: "thread-thread-1",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/thread-1/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      expect(yield* machines.hostReachableUrl(binding, "https://example.com/api")).toBe(
        "https://example.com/api",
      );
      expect(yield* machines.hostReachableUrl(binding, "http://127.0.0.1:4301")).toBe(
        "http://10.42.0.18:4301/",
      );
    }).pipe(Effect.provide(provideIncus(spawner)));
  });
});

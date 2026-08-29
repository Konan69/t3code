import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const INCUS_BINARY = "incus";
const ZFS_BINARY = "zfs";
const INCUS_STORAGE_POOL = "tank";
const WORKSPACE_DEVICE_NAME = "workspace";
const ATTACHMENTS_DEVICE_NAME = "attachments";
const T3_MCP_PROXY_DEVICE_NAME = "t3-mcp";
const IDENTITY_DEVICE_PREFIX = "identity-";
const MACHINE_AGENT_WAIT_LIMIT = "180 seconds";
const ThreadDatasetName = Schema.String.check(Schema.isPattern(/^tank\/threads\/[^/]+$/));
const isThreadDatasetName = Schema.is(ThreadDatasetName);
const MACHINE_GUEST_PATH = [
  `/home/${MACHINE_GUEST_USER}/.local/bin`,
  `/home/${MACHINE_GUEST_USER}/.local/share/pnpm`,
  `/home/${MACHINE_GUEST_USER}/.bun/bin`,
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

export const MachineIdentityMount = Schema.Struct({
  hostPath: Schema.String,
  guestPath: Schema.String,
  readOnly: Schema.Boolean,
});
export type MachineIdentityMount = typeof MachineIdentityMount.Type;

export const MachineIdentityManifest = Schema.Struct({
  version: Schema.Literal(1),
  mounts: Schema.Array(MachineIdentityMount),
});
export type MachineIdentityManifest = typeof MachineIdentityManifest.Type;

export interface EffectiveIds {
  readonly uid: number;
  readonly gid: number;
}

export interface IncusMachineServiceOptions {
  readonly mcpPort?: number;
}

export interface CommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const privilegedCommand = (
  command: string,
  args: ReadonlyArray<string>,
  uid: number | undefined,
): CommandSpec =>
  uid === 0 ? { command, args } : { command: "sudo", args: ["-n", command, ...args] };

export const zfsCommand = (args: ReadonlyArray<string>, uid: number | undefined): CommandSpec =>
  privilegedCommand(ZFS_BINARY, args, uid);

export const guestProviderBinary = (hostCommand: string): string =>
  hostCommand
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:cmd|exe)$/i, "") || hostCommand;

export const guestProviderArgs = (
  hostCommand: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  guestProviderBinary(hostCommand) === "opencode"
    ? args.map((arg) => (arg === "--hostname=127.0.0.1" ? "--hostname=0.0.0.0" : arg))
    : args;

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface MachineExecutableShimSpec {
  readonly machineName: string;
  readonly hostWorkspaceRoot: string;
  readonly guestWorkspaceRoot: string;
  readonly guestUid: string;
  readonly guestGid: string;
  readonly guestCommand: string;
  readonly proxyPort: number;
}

export function buildMachineExecutableShim(spec: MachineExecutableShimSpec): string {
  return `#!/usr/bin/env bash
set -euo pipefail

machine_name=${shellSingleQuote(spec.machineName)}
host_workspace_root=${shellSingleQuote(spec.hostWorkspaceRoot)}
guest_workspace_root=${shellSingleQuote(spec.guestWorkspaceRoot)}
guest_home=${shellSingleQuote(`/home/${MACHINE_GUEST_USER}`)}
guest_path=${shellSingleQuote(MACHINE_GUEST_PATH)}
guest_uid=${shellSingleQuote(spec.guestUid)}
guest_gid=${shellSingleQuote(spec.guestGid)}
guest_command=${shellSingleQuote(spec.guestCommand)}
t3_proxy_port=${shellSingleQuote(String(spec.proxyPort))}

case "$PWD" in
  "$host_workspace_root")
    guest_cwd="$guest_workspace_root"
    ;;
  "$host_workspace_root"/*)
    guest_cwd="$guest_workspace_root/\${PWD#"$host_workspace_root"/}"
    ;;
  *)
    guest_cwd="$guest_workspace_root"
    ;;
esac

rewrite_t3_proxy_url() {
  local value="$1"
  local scheme host prefix
  for scheme in http https ws wss; do
    for host in localhost 0.0.0.0; do
      prefix="$scheme://$host:$t3_proxy_port"
      if [[ "$value" == "$prefix" || "$value" == "$prefix/"* ]]; then
        printf '%s' "$scheme://127.0.0.1:$t3_proxy_port\${value#"$prefix"}"
        return
      fi
    done
  done
  printf '%s' "$value"
}

incus_args=(
  exec "$machine_name"
  --user "$guest_uid"
  --group "$guest_gid"
  --cwd "$guest_cwd"
)
while IFS= read -r -d '' entry; do
  key="\${entry%%=*}"
  value="\${entry#*=}"
  case "$key" in
    PATH|HOME)
      continue
      ;;
  esac
  case "$key" in
    T3_MCP_URL|T3_MCP_*_URL|T3CODE_MCP_URL|T3CODE_MCP_*_URL|T3_SERVER_URL|T3_SERVER_*_URL|T3CODE_SERVER_URL|T3CODE_SERVER_*_URL|T3CODE_*_SERVER_URL)
      value="$(rewrite_t3_proxy_url "$value")"
      ;;
  esac
  incus_args+=(--env "$key=$value")
done < <(env -0)
incus_args+=(--env "PATH=$guest_path" --env "HOME=$guest_home")

exec incus "\${incus_args[@]}" -- "$guest_command" "$@"
`;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const commandError = (operation: string, detail: string, cause?: unknown) =>
  new MachineServiceError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

const isMachineServiceError = Schema.is(MachineServiceError);
class EffectiveIdsService extends Context.Service<EffectiveIdsService, EffectiveIds>()(
  "t3/machine/IncusMachineService/EffectiveIdsService",
) {}

const makeWithEffectiveIds = (options: IncusMachineServiceOptions) =>
  Effect.gen(function* () {
    const effectiveIds = yield* EffectiveIdsService;
    const serverConfig = yield* ServerConfig;
    const uid = effectiveIds.uid;
    const fileSystem = yield* FileSystem.FileSystem;
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
              commandError(
                operation,
                `Failed while running '${command} ${args.join(" ")}'.`,
                cause,
              ),
            ),
          );
          return { code: Number(exitCode), stdout, stderr } satisfies CommandResult;
        }).pipe(Effect.scoped),
    );

    const runZfs = (operation: string, args: ReadonlyArray<string>) => {
      const input = zfsCommand(args, uid);
      return runCommand(operation, input.command, input.args);
    };

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

    const guestIdsByMachine = new Map<string, { readonly uid: string; readonly gid: string }>();
    const resolveGuestIds = Effect.fn("IncusMachineService.resolveGuestIds")(function* (
      machineName: string,
    ) {
      const cached = guestIdsByMachine.get(machineName);
      if (cached) {
        return cached;
      }
      const result = yield* runChecked("guest-user.inspect", INCUS_BINARY, [
        "exec",
        machineName,
        "--",
        "getent",
        "passwd",
        MACHINE_GUEST_USER,
      ]);
      const fields = result.stdout.trim().split(":");
      const uid = fields[2];
      const gid = fields[3];
      if (!uid || !gid || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) {
        return yield* commandError(
          "guest-user.inspect",
          `Could not resolve uid/gid for '${MACHINE_GUEST_USER}' in '${machineName}'.`,
        );
      }
      const resolved = { uid, gid } as const;
      guestIdsByMachine.set(machineName, resolved);
      return resolved;
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

    const loadIdentityManifest = Effect.fn("IncusMachineService.loadIdentityManifest")(
      function* () {
        const manifestPath = serverConfig.machineIdentityManifest?.trim();
        if (!manifestPath) {
          return yield* commandError(
            "identity.manifest",
            "T3_MACHINE_IDENTITY_MANIFEST must name an absolute JSON file when thread machine mode is enabled.",
          );
        }
        if (!path.isAbsolute(manifestPath)) {
          return yield* commandError(
            "identity.manifest",
            `T3_MACHINE_IDENTITY_MANIFEST must be absolute, received '${manifestPath}'.`,
          );
        }

        const raw = yield* fileSystem
          .readFileString(manifestPath)
          .pipe(
            Effect.mapError((cause) =>
              commandError(
                "identity.manifest.read",
                `Could not read identity manifest '${manifestPath}'.`,
                cause,
              ),
            ),
          );
        const manifest = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(MachineIdentityManifest),
          { onExcessProperty: "error" },
        )(raw).pipe(
          Effect.mapError((cause) =>
            commandError(
              "identity.manifest.parse",
              `Identity manifest '${manifestPath}' is invalid: ${String(cause)}`,
              cause,
            ),
          ),
        );

        yield* Effect.forEach(
          manifest.mounts,
          (mount, index) =>
            Effect.gen(function* () {
              if (!path.isAbsolute(mount.hostPath) || !path.isAbsolute(mount.guestPath)) {
                return yield* commandError(
                  "identity.manifest.validate",
                  `Identity mount ${index} must use absolute hostPath and guestPath values.`,
                );
              }
              const info = yield* fileSystem
                .stat(mount.hostPath)
                .pipe(
                  Effect.mapError((cause) =>
                    commandError(
                      "identity.manifest.validate",
                      `Identity hostPath '${mount.hostPath}' at mount ${index} is not an existing directory.`,
                      cause,
                    ),
                  ),
                );
              if (info.type !== "Directory") {
                return yield* commandError(
                  "identity.manifest.validate",
                  `Identity hostPath '${mount.hostPath}' at mount ${index} is not an existing directory.`,
                );
              }
            }),
          { concurrency: 1, discard: true },
        );
        return manifest;
      },
    );

    const runZfsChecked = (operation: string, args: ReadonlyArray<string>) => {
      const input = zfsCommand(args, uid);
      return runChecked(operation, input.command, input.args);
    };

    const runPrivilegedChecked = (
      operation: string,
      command: string,
      args: ReadonlyArray<string>,
    ) => {
      const input = privilegedCommand(command, args, uid);
      return runChecked(operation, input.command, input.args);
    };

    const datasetExists = Effect.fn("IncusMachineService.datasetExists")(function* (
      dataset: string,
    ) {
      const args = ["list", "-H", "-o", "name", dataset] as const;
      const result = yield* runZfs("dataset.inspect", args);
      if (result.code === 0) {
        return true;
      }
      if (result.stderr.toLowerCase().includes("dataset does not exist")) {
        return false;
      }
      const input = zfsCommand(args, uid);
      return yield* commandError(
        "dataset.inspect",
        `'${input.command} ${input.args.join(" ")}' exited with ${result.code}: ${result.stderr.trim()}`,
      );
    });

    const bindingForThread = (threadId: ThreadId) => {
      const machineName = machineNameForThread(threadId);
      return {
        machineId: machineName,
        machineName,
        state: "running",
        hostWorkspaceRoot: hostWorkspaceRootForThread(threadId),
        guestWorkspaceRoot: MACHINE_GUEST_WORKSPACE_ROOT,
      } satisfies ThreadMachineBinding;
    };

    const parentDatasetForBinding = Effect.fn("IncusMachineService.parentDatasetForBinding")(
      function* (binding: ThreadMachineBinding) {
        const workspaceDataset = binding.hostWorkspaceRoot.replace(/^\/+/, "");
        const workspaceSuffix = "/ws";
        const dataset = workspaceDataset.endsWith(workspaceSuffix)
          ? workspaceDataset.slice(0, -workspaceSuffix.length)
          : workspaceDataset;
        if (`${dataset}${workspaceSuffix}` !== workspaceDataset || !isThreadDatasetName(dataset)) {
          return yield* commandError(
            "dataset.destroy",
            `Refusing to destroy dataset '${dataset}'; expected exactly 'tank/threads/<thread id>'.`,
          );
        }
        return dataset;
      },
    );

    const ensureDataset = Effect.fn("IncusMachineService.ensureDataset")(function* (
      threadId: ThreadId,
    ) {
      const dataset = `${INCUS_STORAGE_POOL}/threads/${threadId}/ws`;
      const mountpoint = hostWorkspaceRootForThread(threadId);
      if (!(yield* datasetExists(dataset))) {
        yield* runZfsChecked("dataset.create", [
          "create",
          "-p",
          "-o",
          `mountpoint=${mountpoint}`,
          dataset,
        ]);
      }
      const mountedAt = yield* runZfsChecked("dataset.mountpoint", [
        "get",
        "-H",
        "-o",
        "value",
        "mountpoint",
        dataset,
      ]);
      if (mountedAt.stdout.trim() !== mountpoint) {
        return yield* commandError(
          "dataset.mountpoint",
          `Dataset '${dataset}' is mounted at '${mountedAt.stdout.trim()}', expected '${mountpoint}'.`,
        );
      }
      yield* runPrivilegedChecked("dataset.chown", "chown", [
        `${effectiveIds.uid}:${effectiveIds.gid}`,
        mountpoint,
      ]);
    });

    const imageType = Effect.fn("IncusMachineService.imageType")(function* () {
      const result = yield* runChecked("image.inspect", INCUS_BINARY, [
        "image",
        "list",
        GOLDEN_IMAGE_ALIAS,
        "--format=json",
      ]);
      return yield* Effect.try({
        try: () => {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const parsed = JSON.parse(result.stdout) as ReadonlyArray<{ type?: string }>;
          return parsed[0]?.type === "virtual-machine" ? "virtual-machine" : "container";
        },
        catch: (cause) =>
          commandError("image.inspect", "Incus returned invalid image JSON.", cause),
      });
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

    const ensureAttachmentsDevice = Effect.fn("IncusMachineService.ensureAttachmentsDevice")(
      function* (binding: ThreadMachineBinding) {
        const result = yield* runCommand("attachments.inspect", INCUS_BINARY, [
          "config",
          "device",
          "get",
          binding.machineName,
          ATTACHMENTS_DEVICE_NAME,
          "source",
        ]);
        if (result.code === 0) {
          return;
        }
        yield* runChecked("attachments.add", INCUS_BINARY, [
          "config",
          "device",
          "add",
          binding.machineName,
          ATTACHMENTS_DEVICE_NAME,
          "disk",
          `source=${serverConfig.attachmentsDir}`,
          `path=${serverConfig.attachmentsDir}`,
          "readonly=true",
          "shift=true",
        ]);
      },
    );

    const ensureIdentityDevices = Effect.fn("IncusMachineService.ensureIdentityDevices")(function* (
      binding: ThreadMachineBinding,
    ) {
      const manifest = yield* loadIdentityManifest();
      const listed = yield* runChecked("identity.list", INCUS_BINARY, [
        "config",
        "device",
        "list",
        binding.machineName,
      ]);
      const existingNames = new Set(
        listed.stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      );
      const desiredNames = new Set<string>();

      yield* Effect.forEach(
        manifest.mounts,
        (mount, index) => {
          const rawSlug = path.basename(mount.guestPath).toLowerCase();
          const slug = rawSlug.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
          const deviceName = `${IDENTITY_DEVICE_PREFIX}${index}-${slug}`;
          desiredNames.add(deviceName);

          const desired = {
            source: mount.hostPath,
            path: mount.guestPath,
            shift: "true",
            readonly: mount.readOnly ? "true" : "false",
          } as const;
          if (!existingNames.has(deviceName)) {
            return runChecked("identity.add", INCUS_BINARY, [
              "config",
              "device",
              "add",
              binding.machineName,
              deviceName,
              "disk",
              `source=${desired.source}`,
              `path=${desired.path}`,
              // Keep host ownership unchanged (for example 1001:1002). Incus's
              // effective-id mapping shifts it to the guest user's uid/gid 1000.
              "shift=true",
              ...(mount.readOnly ? ["readonly=true"] : []),
            ]).pipe(Effect.asVoid);
          }

          return Effect.gen(function* () {
            const inspectProperty = (property: keyof typeof desired) =>
              runChecked("identity.inspect", INCUS_BINARY, [
                "config",
                "device",
                "get",
                binding.machineName,
                deviceName,
                property,
              ]);
            const [source, guestPath, shift, readonly] = yield* Effect.all(
              [
                inspectProperty("source"),
                inspectProperty("path"),
                inspectProperty("shift"),
                inspectProperty("readonly"),
              ],
              { concurrency: "unbounded" },
            );
            const actualReadonly = readonly.stdout.trim() === "true" ? "true" : "false";
            if (
              source.stdout.trim() === desired.source &&
              guestPath.stdout.trim() === desired.path &&
              shift.stdout.trim() === desired.shift &&
              actualReadonly === desired.readonly
            ) {
              return;
            }
            yield* runChecked("identity.update", INCUS_BINARY, [
              "config",
              "device",
              "set",
              binding.machineName,
              deviceName,
              `source=${desired.source}`,
              `path=${desired.path}`,
              `shift=${desired.shift}`,
              `readonly=${desired.readonly}`,
            ]);
          });
        },
        { concurrency: 1, discard: true },
      );

      yield* Effect.forEach(
        [...existingNames].filter(
          (name) => name.startsWith(IDENTITY_DEVICE_PREFIX) && !desiredNames.has(name),
        ),
        (name) =>
          runChecked("identity.remove", INCUS_BINARY, [
            "config",
            "device",
            "remove",
            binding.machineName,
            name,
          ]),
        { concurrency: 1, discard: true },
      );
    });

    const ensureT3McpProxyDevice = Effect.fn("IncusMachineService.ensureT3McpProxyDevice")(
      function* (binding: ThreadMachineBinding) {
        const port = options.mcpPort ?? serverConfig.port;
        const desired = {
          listen: `tcp:127.0.0.1:${port}`,
          connect: `tcp:127.0.0.1:${port}`,
          bind: "instance",
        } as const;
        const inspectProperty = (property: keyof typeof desired) =>
          runCommand("mcp-proxy.inspect", INCUS_BINARY, [
            "config",
            "device",
            "get",
            binding.machineName,
            T3_MCP_PROXY_DEVICE_NAME,
            property,
          ]);
        const listen = yield* inspectProperty("listen");
        const connect = listen.code === 0 ? yield* inspectProperty("connect") : undefined;
        const bind = listen.code === 0 ? yield* inspectProperty("bind") : undefined;
        if (
          listen.stdout.trim() === desired.listen &&
          connect?.stdout.trim() === desired.connect &&
          bind?.stdout.trim() === desired.bind
        ) {
          return;
        }
        const config = [
          `listen=${desired.listen}`,
          // With bind=instance, Incus listens on guest loopback and connects
          // from the host namespace, where host loopback reaches T3.
          `connect=${desired.connect}`,
          `bind=${desired.bind}`,
        ];
        yield* runChecked(
          listen.code === 0 ? "mcp-proxy.update" : "mcp-proxy.add",
          INCUS_BINARY,
          listen.code === 0
            ? ["config", "device", "set", binding.machineName, T3_MCP_PROXY_DEVICE_NAME, ...config]
            : [
                "config",
                "device",
                "add",
                binding.machineName,
                T3_MCP_PROXY_DEVICE_NAME,
                "proxy",
                ...config,
              ],
        );
      },
    );

    const waitForAgent = (binding: ThreadMachineBinding) =>
      runChecked("agent.wait", INCUS_BINARY, ["exec", binding.machineName, "--", "true"]).pipe(
        Effect.retry({
          schedule: Schedule.spaced("500 millis").pipe(
            Schedule.upTo({ duration: MACHINE_AGENT_WAIT_LIMIT }),
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

    const ensureWorkspace: MachineServiceShape["ensureWorkspace"] = Effect.fn(
      "IncusMachineService.ensureWorkspace",
    )(function* (threadId) {
      yield* ensureDataset(threadId);
      return Option.some(bindingForThread(threadId));
    });

    const createFromGolden: MachineServiceShape["createFromGolden"] = Effect.fn(
      "IncusMachineService.createFromGolden",
    )(function* (threadId) {
      const binding = bindingForThread(threadId);
      yield* ensureDataset(threadId);
      const current = yield* inspect(binding.machineName);
      if (Option.isNone(current)) {
        const type = yield* imageType();
        yield* runChecked(
          "init",
          INCUS_BINARY,
          type === "virtual-machine"
            ? ["init", GOLDEN_IMAGE_ALIAS, binding.machineName, "--vm"]
            : ["init", GOLDEN_IMAGE_ALIAS, binding.machineName, "-c", "security.nesting=true"],
        );
      }
      yield* ensureWorkspaceDevice(binding);
      yield* ensureIdentityDevices(binding);
      yield* ensureAttachmentsDevice(binding);
      yield* ensureT3McpProxyDevice(binding);
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

    const ensureExecutableShim: MachineServiceShape["ensureExecutableShim"] = Effect.fn(
      "IncusMachineService.ensureExecutableShim",
    )(function* (input) {
      const command = guestProviderBinary(input.command);
      const shimDirectory = path.join(
        serverConfig.baseDir,
        "machine-shims",
        input.binding.machineName,
      );
      const shimPath = path.join(shimDirectory, command);
      const guestIds = yield* resolveGuestIds(input.binding.machineName);
      const contents = buildMachineExecutableShim({
        machineName: input.binding.machineName,
        hostWorkspaceRoot: input.binding.hostWorkspaceRoot,
        guestWorkspaceRoot: input.binding.guestWorkspaceRoot,
        guestUid: guestIds.uid,
        guestGid: guestIds.gid,
        guestCommand: command,
        proxyPort: options.mcpPort ?? serverConfig.port,
      });
      const existing = yield* fileSystem.readFileString(shimPath).pipe(Effect.option);
      if (Option.isNone(existing) || existing.value !== contents) {
        yield* writeFileStringAtomically({ filePath: shimPath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) =>
            commandError(
              "shim.write",
              `Could not write machine executable shim '${shimPath}'.`,
              cause,
            ),
          ),
        );
      }
      yield* fileSystem
        .chmod(shimPath, 0o755)
        .pipe(
          Effect.mapError((cause) =>
            commandError(
              "shim.permissions",
              `Could not make machine executable shim '${shimPath}' executable.`,
              cause,
            ),
          ),
        );
      return shimPath;
    });

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
              ...(input.forceKillAfter !== undefined
                ? { forceKillAfter: input.forceKillAfter }
                : {}),
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
          commandError(
            "exec",
            "Machine execution does not accept host shell launch specifications.",
          ),
        );
      }

      return Effect.gen(function* () {
        const binding = input.binding!;
        yield* ensureIdentityDevices(binding);
        yield* start(binding);
        yield* ensureAttachmentsDevice(binding);
        yield* ensureT3McpProxyDevice(binding);
        const cwd = input.cwd
          ? yield* mappedPath(
              "hostToGuestPath",
              binding.hostWorkspaceRoot,
              binding.guestWorkspaceRoot,
              input.cwd,
            )
          : binding.guestWorkspaceRoot;
        const guestIds = yield* resolveGuestIds(binding.machineName);
        const effectiveEnv = input.extendEnv ? { ...process.env, ...input.env } : input.env;
        const guestEnvEntries = yield* Effect.forEach(
          Object.entries(effectiveEnv ?? {}),
          ([key, value]) => {
            if (value === undefined) {
              return Effect.void;
            }
            if (key === "PATH") {
              return Effect.succeed([key, MACHINE_GUEST_PATH] as const);
            }
            if (key === "HOME") {
              return Effect.succeed([key, `/home/${MACHINE_GUEST_USER}`] as const);
            }
            if (
              value === binding.hostWorkspaceRoot ||
              value.startsWith(`${binding.hostWorkspaceRoot}${path.sep}`)
            ) {
              return mappedPath(
                "hostToGuestPath",
                binding.hostWorkspaceRoot,
                binding.guestWorkspaceRoot,
                value,
              ).pipe(Effect.map((mapped) => [key, mapped] as const));
            }
            return Effect.succeed([key, value] as const);
          },
          { concurrency: 1 },
        );
        const envArgs = guestEnvEntries.flatMap((entry) =>
          entry === undefined ? [] : ["--env", `${entry[0]}=${entry[1]}`],
        );
        const command = guestProviderBinary(input.command);
        const args = guestProviderArgs(input.command, input.args);
        return yield* spawner.spawn(
          ChildProcess.make(
            INCUS_BINARY,
            [
              "exec",
              binding.machineName,
              "--user",
              guestIds.uid,
              "--group",
              guestIds.gid,
              "--cwd",
              cwd,
              ...envArgs,
              "--",
              command,
              ...args,
            ],
            {
              ...(input.detached !== undefined ? { detached: input.detached } : {}),
              ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
              ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
              ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
              ...(input.forceKillAfter !== undefined
                ? { forceKillAfter: input.forceKillAfter }
                : {}),
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
        const dataset = yield* parentDatasetForBinding(binding);
        if (yield* datasetExists(dataset)) {
          yield* runZfsChecked("dataset.destroy", ["destroy", "-r", dataset]);
        }
      },
    );

    const hostReachableUrl: MachineServiceShape["hostReachableUrl"] = Effect.fn(
      "IncusMachineService.hostReachableUrl",
    )(function* (binding, value) {
      const url = new URL(value);
      if (
        url.hostname !== "127.0.0.1" &&
        url.hostname !== "localhost" &&
        url.hostname !== "0.0.0.0"
      ) {
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
            state?: {
              network?: Record<string, { addresses?: ReadonlyArray<{ address?: string }> }>;
            };
          }>,
        catch: (cause) =>
          commandError("network.inspect", "Incus returned invalid network JSON.", cause),
      });
      const address = Object.values(rows[0]?.state?.network ?? {})
        .flatMap((network) => network.addresses ?? [])
        .map((entry) => entry.address)
        .find(
          (entry) =>
            entry?.includes(".") === true && entry !== "0.0.0.0" && !entry.startsWith("127."),
        );
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
      ensureWorkspace,
      createFromGolden,
      start,
      stop,
      exec,
      ensureExecutableShim,
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

export const make = (
  effectiveIds: EffectiveIds = {
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
  },
  options: IncusMachineServiceOptions = {},
) => makeWithEffectiveIds(options).pipe(Effect.provideService(EffectiveIdsService, effectiveIds));

export const layer = Layer.effect(MachineService, make());

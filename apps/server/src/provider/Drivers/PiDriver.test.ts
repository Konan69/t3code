// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ProcessLauncher } from "../../process/ProcessLauncher.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PiDriver } from "./PiDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.mock(ProcessLauncher, {})),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy, {
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

it.layer(testLayer)("PiDriver", (it) => {
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "refreshes native maintenance for the configured pi executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const binaryPath = path.join(directory, "Pi Tools", "bin", "pi");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* PiDriver.create({
          instanceId: ProviderInstanceId.make("pi-maintenance"),
          displayName: "pi test",
          enabled: false,
          environment: [],
          config: { ...PiDriver.defaultConfig(), binaryPath },
        });

        expect((yield* instance.snapshot.resolveMaintenance()).update).toMatchObject({
          executable: binaryPath,
          args: ["update", "--self"],
          command: `'${binaryPath}' update --self`,
          lockKey: "pi-native",
        });
        expect((yield* instance.snapshot.refresh).status).toBe("disabled");

        yield* fs.remove(binaryPath);
        expect((yield* instance.snapshot.resolveMaintenance({ fresh: true })).update).toBeNull();
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled pi must not spawn a process")),
        ),
        Effect.scoped,
      ),
  );
});

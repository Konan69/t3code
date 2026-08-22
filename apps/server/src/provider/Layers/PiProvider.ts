/**
 * PiProvider — availability probe and snapshot builder for the pi driver.
 *
 * Mirrors GrokProvider: a cheap `pi --version` probe decides installed /
 * missing, model discovery is static (pi resolves its own models at session
 * start; T3 Code surfaces configured custom models plus common defaults).
 *
 * @module provider/Layers/PiProvider
 */
import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "pi",
  badgeLabel: "Community",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Static presentation models. pi's live model catalog depends on which
 * providers the user authenticated (`pi auth`), so the snapshot keeps a
 * small default set and lets `customModels` extend it. Sessions always run
 * with pi's own model resolution unless the user picks one here.
 */
const PI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "openai/gpt-5.6-codex",
    name: "GPT-5.6 Codex",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking pi CLI availability...",
      },
    });
  });
}

export function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(PI_BUILT_IN_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

const runPiVersionCommand = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const result = versionResult.success.value;
  const version = parseGenericCliVersion(result.stdout) ?? parseGenericCliVersion(result.stderr);

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      // pi defers authentication to whichever provider credentials exist in
      // ~/.pi/agent/auth.json; there is no cheap offline auth probe, so we
      // report unknown rather than guessing.
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

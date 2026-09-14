/**
 * PiProvider — availability probe and live model discovery for the pi driver.
 *
 * `pi --version` decides installed/missing. A second short-lived RPC process
 * requests `get_available_models` and `get_state`, preserving pi extension
 * providers (for example claude-bridge) while skipping skills and tools.
 * Models carry `subProvider` so every T3 model surface can show provenance.
 *
 * @module provider/Layers/PiProvider
 */
import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
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
const MODEL_DISCOVERY_TIMEOUT_MS = 45_000;
const MODEL_COMMAND_ID = "t3-pi-models";
const STATE_COMMAND_ID = "t3-pi-state";

const PI_DISCOVERY_STDIN = [
  JSON.stringify({ id: MODEL_COMMAND_ID, type: "get_available_models" }),
  JSON.stringify({ id: STATE_COMMAND_ID, type: "get_state" }),
  "",
].join("\n");

const PI_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "claude-bridge": "Claude Bridge",
  google: "Google",
  "openai-codex": "OpenAI Codex",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
};

interface PiRpcModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
}

export interface PiModelDiscovery {
  readonly models: ReadonlyArray<PiRpcModel>;
  readonly currentModelSlug?: string | undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function decodePiRpcModel(value: unknown): PiRpcModel | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = nonEmptyString(record.provider);
  const id = nonEmptyString(record.id);
  const name = nonEmptyString(record.name);
  if (!provider || !id || !name) {
    return undefined;
  }
  return {
    provider,
    id,
    name,
    reasoning: record.reasoning === true,
  };
}

/**
 * Decode the strict-LF pi JSONL response. Unrelated extension UI events and
 * malformed lines are ignored; the model response is mandatory.
 */
export function parsePiModelDiscovery(stdout: string): PiModelDiscovery | undefined {
  let models: ReadonlyArray<PiRpcModel> | undefined;
  let currentModelSlug: string | undefined;

  for (let rawLine of stdout.split("\n")) {
    if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);
    if (rawLine.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type !== "response" || message.success !== true) {
      continue;
    }
    const data = message.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      continue;
    }
    const dataRecord = data as Record<string, unknown>;

    if (message.id === MODEL_COMMAND_ID && Array.isArray(dataRecord.models)) {
      models = dataRecord.models
        .map(decodePiRpcModel)
        .filter((model): model is PiRpcModel => model !== undefined);
      continue;
    }

    if (message.id === STATE_COMMAND_ID) {
      const model = dataRecord.model;
      if (model !== null && typeof model === "object" && !Array.isArray(model)) {
        const modelRecord = model as Record<string, unknown>;
        const provider = nonEmptyString(modelRecord.provider);
        const id = nonEmptyString(modelRecord.id);
        if (provider && id) currentModelSlug = `${provider}/${id}`;
      }
    }
  }

  return models ? { models, ...(currentModelSlug ? { currentModelSlug } : {}) } : undefined;
}

export function piProviderLabel(providerId: string): string {
  return (
    PI_PROVIDER_LABELS[providerId] ??
    providerId
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function parseExcludedPiProviders(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((provider) => provider.trim().toLowerCase())
      .filter((provider) => provider.length > 0),
  );
}

export function piModelsFromDiscovery(
  discovery: PiModelDiscovery,
  excludedProviders: ReadonlySet<string>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const model of discovery.models) {
    const providerId = model.provider.toLowerCase();
    if (excludedProviders.has(providerId)) continue;
    const slug = `${model.provider}/${model.id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model.name,
      subProvider: piProviderLabel(model.provider),
      isCustom: false,
      ...(slug === discovery.currentModelSlug ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }

  return models.toSorted(
    (left, right) =>
      (left.subProvider ?? "").localeCompare(right.subProvider ?? "") ||
      left.name.localeCompare(right.name) ||
      left.slug.localeCompare(right.slug),
  );
}

function providerIdFromModelSlug(slug: string): string | undefined {
  const withoutThinking = slug.split(":", 1)[0] ?? slug;
  const separator = withoutThinking.indexOf("/");
  return separator > 0 ? withoutThinking.slice(0, separator).toLowerCase() : undefined;
}

function fallbackModelSlugs(piSettings: PiSettings): ReadonlyArray<string> {
  const configuredDefault = piSettings.defaultModel.trim();
  return [
    ...(configuredDefault ? [configuredDefault.split(":", 1)[0] ?? configuredDefault] : []),
    ...piSettings.customModels,
  ];
}

export function piModelsFromSettings(
  piSettings: PiSettings,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  const excludedProviders = parseExcludedPiProviders(piSettings.excludedProviders);
  const visibleDiscovered = discoveredModels.filter((model) => {
    const providerId = providerIdFromModelSlug(model.slug);
    return providerId === undefined || !excludedProviders.has(providerId);
  });
  return providerModelsFromSettings(
    visibleDiscovered,
    fallbackModelSlugs(piSettings).filter((slug) => {
      const providerId = providerIdFromModelSlug(slug);
      return providerId === undefined || !excludedProviders.has(providerId);
    }),
    EMPTY_CAPABILITIES,
  ).map((model) => {
    if (model.subProvider || !model.isCustom) return model;
    const providerId = providerIdFromModelSlug(model.slug);
    return providerId ? { ...model, subProvider: piProviderLabel(providerId) } : model;
  });
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings);

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
        message: "Checking pi CLI and discovering models...",
      },
    });
  });
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

const runPiModelDiscovery = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const args = ["--mode", "rpc", "--no-session", "--no-skills", "--no-tools"];
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        stdin: { stream: Stream.encodeText(Stream.make(PI_DISCOVERY_STDIN)) },
      }),
    );
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings);

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
    yield* Effect.logWarning("pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
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
      enabled: true,
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

  const versionOutput = versionResult.success.value;
  const version =
    parseGenericCliVersion(versionOutput.stdout) ?? parseGenericCliVersion(versionOutput.stderr);

  const discoveryResult = yield* runPiModelDiscovery(piSettings, environment).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(discoveryResult)) {
    yield* Effect.logWarning("pi model discovery failed.", {
      errorTag: discoveryResult.failure._tag,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "pi is ready, but live model discovery failed.",
      },
    });
  }

  if (Option.isNone(discoveryResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `pi is ready, but model discovery timed out after ${String(
          MODEL_DISCOVERY_TIMEOUT_MS / 1000,
        )} seconds.`,
      },
    });
  }

  const discoveryCommand = discoveryResult.success.value;
  const discovery =
    discoveryCommand.code === 0 ? parsePiModelDiscovery(discoveryCommand.stdout) : undefined;
  if (!discovery) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "pi is ready, but returned an invalid model discovery response.",
      },
    });
  }

  const discoveredModels = piModelsFromDiscovery(
    discovery,
    parseExcludedPiProviders(piSettings.excludedProviders),
  );
  const models = piModelsFromSettings(piSettings, discoveredModels);
  const providerCount = new Set(models.map((model) => model.subProvider).filter(Boolean)).size;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: `Discovered ${String(models.length)} models across ${String(
        providerCount,
      )} pi providers.`,
    },
  });
});

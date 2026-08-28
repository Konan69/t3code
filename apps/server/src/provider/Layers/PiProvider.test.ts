import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  parseExcludedPiProviders,
  parsePiModelDiscovery,
  piModelsFromDiscovery,
  piModelsFromSettings,
  piProviderLabel,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const discoveryJsonl = [
  JSON.stringify({ type: "extension_ui_request", id: "ignored", method: "setStatus" }),
  JSON.stringify({
    id: "t3-pi-models",
    type: "response",
    command: "get_available_models",
    success: true,
    data: {
      models: [
        { provider: "google", id: "gemini-3-flash", name: "Gemini 3 Flash" },
        { provider: "openai", id: "gpt-5", name: "GPT-5 API" },
        { provider: "anthropic", id: "claude-api", name: "Claude API" },
        { provider: "opencode-go", id: "gpt-5", name: "GPT-5 Go" },
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
        },
        {
          provider: "claude-bridge",
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
        },
        { provider: "openrouter", id: "qwen/qwen3-coder", name: "Qwen3 Coder" },
        { provider: "opencode", id: "gpt-5", name: "GPT-5" },
        { provider: "openrouter", id: "qwen/qwen3-coder", name: "Duplicate" },
        { provider: "", id: "bad", name: "Invalid" },
      ],
    },
  }),
  "not-json",
  JSON.stringify({
    id: "t3-pi-state",
    type: "response",
    command: "get_state",
    success: true,
    data: { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
  }),
  "",
].join("\n");

describe("pi model discovery", () => {
  it("decodes model and active-state responses while ignoring unrelated lines", () => {
    const discovery = parsePiModelDiscovery(discoveryJsonl);
    expect(discovery?.models).toHaveLength(9);
    expect(discovery?.currentModelSlug).toBe("openai-codex/gpt-5.6-sol");
  });

  it("uses exact provider exclusions and preserves subscription bridges", () => {
    const discovery = parsePiModelDiscovery(discoveryJsonl)!;
    const excluded = parseExcludedPiProviders("google, openai, anthropic, opencode-go");
    const models = piModelsFromDiscovery(discovery, excluded);

    expect(models.map((model) => model.slug)).toEqual([
      "claude-bridge/claude-sonnet-5",
      "openai-codex/gpt-5.6-sol",
      "opencode/gpt-5",
      "openrouter/qwen/qwen3-coder",
    ]);
    expect(models.find((model) => model.slug === "openai-codex/gpt-5.6-sol")).toMatchObject({
      subProvider: "OpenAI Codex",
      isDefault: true,
    });
    expect(models.find((model) => model.slug === "claude-bridge/claude-sonnet-5")).toMatchObject({
      subProvider: "Claude Bridge",
    });
  });

  it("defaults this fork to excluding raw-key and opencode-go providers", () => {
    const settings = decodePiSettings({});
    expect(settings.excludedProviders).toBe("google, openai, anthropic, opencode-go");

    const models = piModelsFromSettings(
      settings,
      piModelsFromDiscovery(
        parsePiModelDiscovery(discoveryJsonl)!,
        parseExcludedPiProviders(settings.excludedProviders),
      ),
    );
    expect(models.map((model) => model.subProvider)).toEqual([
      "Claude Bridge",
      "OpenAI Codex",
      "OpenCode",
      "OpenRouter",
    ]);
  });

  it("humanizes unknown provider ids without losing the exact slug", () => {
    expect(piProviderLabel("some-new_provider")).toBe("Some New Provider");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";

describe("buildModelPickerSearchText", () => {
  it("builds provider-agnostic search text from generic fields", () => {
    expect(
      buildModelPickerSearchText({
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      }),
    ).toBe("claude opus 4.7 github copilot opencode opencode");
  });
});

describe("scoreModelPickerSearch", () => {
  it("matches typo-tolerant multi-token queries", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "opencode",
          providerDisplayName: "opencode",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
        },
        "coplt op",
      ),
    ).not.toBeNull();
  });

  it("matches provider and model tokens in any order", () => {
    const model = {
      driverKind: "pi",
      providerDisplayName: "pi",
      slug: "openai-codex/gpt-5.4",
      name: "GPT-5.4",
      subProvider: "OpenAI Codex",
    };

    expect(scoreModelPickerSearch(model, "open 5.4")).not.toBeNull();
    expect(scoreModelPickerSearch(model, "5.4 open")).not.toBeNull();
    expect(scoreModelPickerSearch(model, "open missing")).toBeNull();
  });

  it("indexes full provider/model slugs", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "pi",
          providerDisplayName: "pi",
          slug: "openrouter/qwen/qwen3-coder",
          name: "Qwen3 Coder",
          subProvider: "OpenRouter",
        },
        "openrouter qwen3-coder",
      ),
    ).not.toBeNull();
  });

  it("rejects results when any query token does not match", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "codex",
          providerDisplayName: "codex",
          name: "GPT-5 Codex",
        },
        "coplt op",
      ),
    ).toBeNull();
  });

  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exactScore = scoreModelPickerSearch(
      {
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "copilot opus",
    );
    const fuzzyScore = scoreModelPickerSearch(
      {
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "coplt op",
    );

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });

  it("gives favorite models a strong enough ranking boost for partial queries", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opu",
    );
    const nonFavoriteScore = scoreModelPickerSearch(
      {
        driverKind: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.5",
      },
      "opu",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteScore).not.toBeNull();
    expect(favoriteScore!).toBeLessThan(nonFavoriteScore!);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opus 4.7",
    );
    const nonFavoriteExactScore = scoreModelPickerSearch(
      {
        driverKind: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.7",
      },
      "opus 4.7",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });

  it("matches a custom instance's display name against its models", () => {
    expect(
      scoreModelPickerSearch(
        {
          driverKind: "codex",
          providerDisplayName: "Codex Personal",
          name: "GPT-5 Codex",
        },
        "personal",
      ),
    ).not.toBeNull();
  });
});

/**
 * PiTextGeneration — per-instance commit/PR/branch/title generation backed by
 * one-shot `pi --mode text -p` runs.
 *
 * pi has no structured-output flag, so prompts request JSON and we extract
 * the outermost object from the response. Parsing is deliberately lenient:
 * fenced code blocks and prose around the JSON are tolerated.
 *
 * @module textGeneration/PiTextGeneration
 */
import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "./TextGeneration.ts";
import type { PiSettings } from "@t3tools/contracts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;

type TextGenOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/** Extract the outermost JSON object from a possibly chatty response. */
export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piConfig: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiPrompt = (
    operation: TextGenOperation,
    prompt: string,
    modelSlug?: string | undefined,
    timeoutMs = PI_TIMEOUT_MS,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      const modelArgs = modelSlug ? ["--model", modelSlug] : [];
      const spawnOptions = environment ? { env: environment } : {};
      const spawnCommand = yield* resolveSpawnCommand(
        piConfig.binaryPath || "pi",
        ["--mode", "text", "--no-session", "-p", prompt, ...modelArgs],
        spawnOptions,
      ).pipe(
        Effect.mapError((cause) =>
          normalizeCliError("pi", operation, cause, "Failed to resolve the pi command path"),
        ),
      );
      const collectRun = Effect.gen(function* () {
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              shell: spawnCommand.shell,
              env: environment ?? undefined,
              extendEnv: environment === undefined,
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", operation, cause, "Failed to spawn the pi CLI process"),
            ),
          );
        const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
          stream.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          );
        return yield* Effect.all(
          [collectText(child.stdout), collectText(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
      });
      const [stdout, stderr, exitCode] = yield* Effect.scoped(collectRun);
      const code = Number(exitCode);
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail: `pi CLI command failed with code ${code}${detail ? `: ${detail}` : "."}`,
        });
      }
      return stdout;
    }).pipe(
      Effect.catch((cause) =>
        cause._tag === "TextGenerationError"
          ? Effect.fail(cause as TextGenerationError)
          : new TextGenerationError({
              operation,
              detail: "pi CLI run failed.",
              cause,
            }),
      ),
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : new TextGenerationError({
              operation,
              detail: `pi CLI timed out after ${String(timeoutMs)}ms.`,
            }),
      ),
    );

  const parseJsonResponse = (
    operation: TextGenOperation,
    stdout: string,
  ): Effect.Effect<Record<string, unknown>, TextGenerationError> => {
    const parsed = extractJsonObject(stdout);
    if (!parsed) {
      return new TextGenerationError({
        operation,
        detail: "pi did not return a parseable JSON response.",
      });
    }
    return Effect.succeed(parsed);
  };

  const resolveModelSlug = (modelSelection: ModelSelection | undefined): string | undefined =>
    modelSelection?.model?.trim() || undefined;

  const ignoreAttachments = (attachments: ReadonlyArray<ChatAttachment> | undefined): void => {
    // v1: image attachments are not forwarded to one-shot text generation.
    void attachments;
  };

  return {
    generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ): Effect.Effect<CommitMessageGenerationResult, TextGenerationError> =>
      Effect.gen(function* () {
        const stdout = yield* runPiPrompt(
          "generateCommitMessage",
          buildCommitMessagePrompt(input).prompt,
          resolveModelSlug(input.modelSelection),
        );
        const parsed = yield* parseJsonResponse("generateCommitMessage", stdout);
        const subject = sanitizeCommitSubject(stringField(parsed, "subject") ?? "");
        if (!subject) {
          return yield* new TextGenerationError({
            operation: "generateCommitMessage",
            detail: "pi returned an empty commit subject.",
          });
        }
        return {
          subject,
          body: stringField(parsed, "body") ?? "",
          ...(input.includeBranch === true && stringField(parsed, "branch")
            ? {
                branch:
                  sanitizeFeatureBranchName(stringField(parsed, "branch") ?? "") ||
                  sanitizeBranchFragment(stringField(parsed, "branch") ?? ""),
              }
            : {}),
        };
      }),

    generatePrContent: (
      input: PrContentGenerationInput,
    ): Effect.Effect<PrContentGenerationResult, TextGenerationError> =>
      Effect.gen(function* () {
        const stdout = yield* runPiPrompt(
          "generatePrContent",
          buildPrContentPrompt(input).prompt,
          resolveModelSlug(input.modelSelection),
        );
        const parsed = yield* parseJsonResponse("generatePrContent", stdout);
        const title = sanitizePrTitle(stringField(parsed, "title") ?? "");
        if (!title) {
          return yield* new TextGenerationError({
            operation: "generatePrContent",
            detail: "pi returned an empty PR title.",
          });
        }
        return { title, body: stringField(parsed, "body") ?? "" };
      }),

    generateBranchName: (
      input: BranchNameGenerationInput,
    ): Effect.Effect<BranchNameGenerationResult, TextGenerationError> =>
      Effect.gen(function* () {
        ignoreAttachments(input.attachments);
        const stdout = yield* runPiPrompt(
          "generateBranchName",
          buildBranchNamePrompt(input).prompt,
          resolveModelSlug(input.modelSelection),
        );
        const parsed = yield* parseJsonResponse("generateBranchName", stdout);
        const branch =
          sanitizeFeatureBranchName(stringField(parsed, "branch") ?? "") ||
          sanitizeBranchFragment(stringField(parsed, "branch") ?? "");
        if (!branch) {
          return yield* new TextGenerationError({
            operation: "generateBranchName",
            detail: "pi returned an empty branch name.",
          });
        }
        return { branch };
      }),

    generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ): Effect.Effect<ThreadTitleGenerationResult, TextGenerationError> =>
      Effect.gen(function* () {
        ignoreAttachments(input.attachments);
        const stdout = yield* runPiPrompt(
          "generateThreadTitle",
          buildThreadTitlePrompt(input).prompt,
          resolveModelSlug(input.modelSelection),
        );
        const parsed = yield* parseJsonResponse("generateThreadTitle", stdout);
        const title = sanitizeThreadTitle(stringField(parsed, "title") ?? "");
        if (!title) {
          return yield* new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "pi returned an empty thread title.",
          });
        }
        return { title };
      }),
  };
});

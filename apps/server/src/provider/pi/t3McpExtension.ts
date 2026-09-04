// @effect-diagnostics globalConsole:off - this standalone pi extension runs outside Effect.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

const ENDPOINT_ENV = "T3_CODE_MCP_ENDPOINT";
const TOKEN_ENV = "T3_CODE_MCP_BEARER_TOKEN";

interface PiTextContent {
  readonly type: "text";
  readonly text: string;
}

interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

type PiToolContent = PiTextContent | PiImageContent;

interface PiToolResult {
  readonly content: ReadonlyArray<PiToolContent>;
  readonly details: Record<string, unknown>;
}

interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<PiToolResult>;
}

interface PiExtensionApi {
  readonly registerTool: (tool: PiToolDefinition) => unknown;
  readonly on: (
    event: "session_start" | "session_shutdown",
    handler: (...args: ReadonlyArray<unknown>) => Promise<void> | void,
  ) => unknown;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Record<string, object> | undefined;
    readonly required?: ReadonlyArray<string> | undefined;
    readonly [key: string]: unknown;
  };
}

interface McpToolClient {
  readonly callTool: (
    input: { readonly name: string; readonly arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
}

const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const contentText = (content: ReadonlyArray<PiToolContent>): string =>
  content
    .filter((item): item is PiTextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

export function toPiToolResult(toolName: string, result: unknown): PiToolResult {
  if (typeof result !== "object" || result === null) {
    return {
      content: [{ type: "text", text: jsonText(result) }],
      details: { server: "t3-code", tool: toolName },
    };
  }

  const record = result as Record<string, unknown>;
  if ("toolResult" in record) {
    return {
      content: [{ type: "text", text: jsonText(record.toolResult) }],
      details: { server: "t3-code", tool: toolName },
    };
  }

  const content: Array<PiToolContent> = [];
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (typeof item !== "object" || item === null) continue;
      const part = item as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
        continue;
      }
      if (part.type === "resource" && typeof part.resource === "object" && part.resource) {
        const resource = part.resource as Record<string, unknown>;
        const body =
          typeof resource.text === "string"
            ? resource.text
            : typeof resource.blob === "string"
              ? resource.blob
              : jsonText(resource);
        content.push({
          type: "text",
          text: `${typeof resource.uri === "string" ? `${resource.uri}\n` : ""}${body}`,
        });
        continue;
      }
      content.push({ type: "text", text: jsonText(part) });
    }
  }
  if (content.length === 0 && record.structuredContent !== undefined) {
    content.push({ type: "text", text: jsonText(record.structuredContent) });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "T3 MCP tool completed." });
  }

  if (record.isError === true) {
    const detail = contentText(content) || "Unknown MCP error";
    throw new Error(`T3 MCP tool '${toolName}' failed: ${detail}`);
  }

  return {
    content,
    details: {
      server: "t3-code",
      tool: toolName,
      ...(record.structuredContent !== undefined
        ? { structuredContent: record.structuredContent }
        : {}),
    },
  };
}

export function registerT3McpTools(
  pi: Pick<PiExtensionApi, "registerTool">,
  client: McpToolClient,
  tools: ReadonlyArray<McpToolDefinition>,
): void {
  for (const tool of tools) {
    const description = tool.description?.trim() || `T3 Code tool: ${tool.name}`;
    pi.registerTool({
      name: tool.name,
      label: `T3: ${tool.name}`,
      description,
      promptSnippet: description,
      parameters: Type.Unsafe(tool.inputSchema as never),
      execute: async (_toolCallId, params, signal) => {
        const result = await client.callTool(
          {
            name: tool.name,
            arguments:
              typeof params === "object" && params !== null
                ? (params as Record<string, unknown>)
                : {},
          },
          undefined,
          signal ? { signal } : undefined,
        );
        return toPiToolResult(tool.name, result);
      },
    });
  }
}

export default function t3McpExtension(pi: PiExtensionApi): void {
  let generation = 0;
  let client: Client | undefined;

  const closeClient = async () => {
    const current = client;
    client = undefined;
    if (current) await current.close();
  };

  pi.on("session_start", async () => {
    const currentGeneration = ++generation;
    await closeClient();

    const endpoint = process.env[ENDPOINT_ENV]?.trim();
    const token = process.env[TOKEN_ENV]?.trim();
    if (!endpoint || !token) return;

    const nextClient = new Client({ name: "t3-code-pi", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      await nextClient.connect(transport as never);
      const response = await nextClient.listTools();
      if (currentGeneration !== generation) {
        await nextClient.close();
        return;
      }
      client = nextClient;
      registerT3McpTools(pi, nextClient as unknown as McpToolClient, response.tools);
    } catch (error) {
      await nextClient.close().catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`T3 MCP initialization failed: ${detail}`);
    }
  });

  pi.on("session_shutdown", async () => {
    generation += 1;
    await closeClient();
  });
}

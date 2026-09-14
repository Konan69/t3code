import { describe, expect, it, vi } from "vite-plus/test";

import { registerT3McpTools, toPiToolResult } from "./t3McpExtension.ts";

describe("T3 pi MCP extension", () => {
  it("preserves text and image tool content", () => {
    expect(
      toPiToolResult("preview_capture", {
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        structuredContent: { path: "/tmp/capture.png" },
      }),
    ).toEqual({
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      details: {
        server: "t3-code",
        tool: "preview_capture",
        structuredContent: { path: "/tmp/capture.png" },
      },
    });
  });

  it("throws when MCP marks a tool result as an error", () => {
    expect(() =>
      toPiToolResult("preview_click", {
        isError: true,
        content: [{ type: "text", text: "element not found" }],
      }),
    ).toThrow("T3 MCP tool 'preview_click' failed: element not found");
  });

  it("registers discovered tools and forwards arguments and cancellation", async () => {
    const registerTool = vi.fn();
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "clicked" }],
    }));
    registerT3McpTools({ registerTool }, { callTool }, [
      {
        name: "preview_click",
        description: "Click a preview element",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
          required: ["selector"],
        },
      },
    ]);

    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool).toMatchObject({
      name: "preview_click",
      label: "T3: preview_click",
      description: "Click a preview element",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    });

    const controller = new AbortController();
    await expect(tool.execute("call-1", { selector: "#save" }, controller.signal)).resolves.toEqual(
      {
        content: [{ type: "text", text: "clicked" }],
        details: { server: "t3-code", tool: "preview_click" },
      },
    );
    expect(callTool).toHaveBeenCalledWith(
      { name: "preview_click", arguments: { selector: "#save" } },
      undefined,
      { signal: controller.signal },
    );
  });
});

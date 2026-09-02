// @effect-diagnostics nodeBuiltinImport:off - verifies atomic extension installation on a real temporary filesystem.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { installPiMcpExtension, makePiMcpLaunchConfig } from "./PiAdapter.ts";

describe("PiAdapter T3 MCP launch configuration", () => {
  it("passes the scoped credential through child env, never argv", () => {
    const result = makePiMcpLaunchConfig({
      endpoint: "http://10.0.0.1:3773/mcp",
      authorizationHeader: "Bearer secret-token",
      extensionPath: "/home/kixey/.pi/agent/extensions/t3-code-mcp.mjs",
      environment: { PATH: "/usr/bin" },
    });

    expect(result).toEqual({
      args: ["-e", "/home/kixey/.pi/agent/extensions/t3-code-mcp.mjs"],
      environment: {
        PATH: "/usr/bin",
        T3_CODE_MCP_ENDPOINT: "http://10.0.0.1:3773/mcp",
        T3_CODE_MCP_BEARER_TOKEN: "secret-token",
      },
    });
    expect(JSON.stringify(result?.args)).not.toContain("secret-token");
  });

  it("withholds MCP for an invalid authorization header", () => {
    expect(
      makePiMcpLaunchConfig({
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "not-a-bearer",
        extensionPath: "/tmp/t3-code-mcp.mjs",
      }),
    ).toBeUndefined();
  });

  it("atomically installs and updates the T3-owned extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "t3-pi-mcp-"));
    const source = join(directory, "source.mjs");
    const target = join(directory, "extensions", "t3-code-mcp.mjs");
    writeFileSync(source, "export default () => 'v1';\n");

    installPiMcpExtension(source, target);
    expect(readFileSync(target, "utf8")).toBe("export default () => 'v1';\n");

    writeFileSync(source, "export default () => 'v2';\n");
    installPiMcpExtension(source, target);
    expect(readFileSync(target, "utf8")).toBe("export default () => 'v2';\n");
  });
});

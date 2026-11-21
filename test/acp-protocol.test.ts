import { describe, expect, test } from "bun:test";
import { buildInitializeResult, decodeMcpServers, McpServerSchema } from "../src/acp/protocol.ts";
import { toDaemonMcpServer } from "../src/serve/session.ts";
import { Schema } from "effect";

describe("ACP protocol - MCP capabilities and schema", () => {
  test("buildInitializeResult advertises mcpCapabilities: { http: true, sse: true }", () => {
    const init = buildInitializeResult();
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities.loadSession).toBe(true);
    expect(init.agentCapabilities.mcpCapabilities).toEqual({
      http: true,
      sse: true,
    });
  });

  test("McpServerSchema validates HTTP, SSE, and Stdio schemas", () => {
    const decode = Schema.decodeUnknownSync(McpServerSchema);

    // HTTP
    const http = decode({
      type: "http",
      name: "t3-code",
      url: "http://127.0.0.1:41234",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
    expect(http.type).toBe("http");
    expect(http.name).toBe("t3-code");

    // SSE
    const sse = decode({
      type: "sse",
      name: "sse-server",
      url: "http://127.0.0.1:41235/sse",
    });
    expect(sse.type).toBe("sse");
    expect(sse.name).toBe("sse-server");

    // Stdio with type: "stdio"
    const stdio1 = decode({
      type: "stdio",
      name: "stdio-server",
      command: "/usr/bin/tool",
      args: ["--mode", "daemon"],
      env: [{ name: "ENV_VAR", value: "1" }],
    });
    expect(stdio1.name).toBe("stdio-server");
    expect("command" in stdio1 && stdio1.command).toBe("/usr/bin/tool");

    // Stdio without type (ACP v1 compat)
    const stdio2 = decode({
      name: "stdio-v1",
      command: "node",
      args: ["server.js"],
    });
    expect(stdio2.name).toBe("stdio-v1");
    expect("command" in stdio2 && stdio2.command).toBe("node");
  });

  test("decodeMcpServers filters out malformed or foreign entries safely without throwing", () => {
    const rawList = [
      {
        type: "http",
        name: "valid-http",
        url: "http://localhost:8080",
        headers: [{ name: "H", value: "V" }],
      },
      // Missing url
      { type: "http", name: "bad-http" },
      // Foreign type (e.g. acp server transport not supported)
      { type: "acp", name: "foreign-acp", serverId: "srv-1" },
      // Stdio valid
      {
        type: "stdio",
        name: "valid-stdio",
        command: "bun",
        args: ["run"],
      },
      // Non-object
      null,
      123,
      "not-an-object",
    ];

    const decoded = decodeMcpServers(rawList);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.name).toBe("valid-http");
    expect(decoded[1]!.name).toBe("valid-stdio");

    // Non-array input returns empty array safely
    expect(decodeMcpServers(null)).toEqual([]);
    expect(decodeMcpServers(undefined)).toEqual([]);
    expect(decodeMcpServers({})).toEqual([]);
  });

  test("toDaemonMcpServer maps to zcodeProtocolMcpServerSchema format", () => {
    // HTTP
    const httpDaemon = toDaemonMcpServer({
      type: "http",
      name: "t3-code",
      url: "http://127.0.0.1:4000",
      headers: [{ name: "Authorization", value: "Bearer 123" }],
    });
    expect(httpDaemon).toEqual({
      name: "t3-code",
      type: "http",
      url: "http://127.0.0.1:4000",
      headers: [{ name: "Authorization", value: "Bearer 123" }],
      isolation: "session",
      alwaysLoad: true,
    });

    // HTTP with missing headers defaults to []
    const httpNoHeaders = toDaemonMcpServer({
      type: "http",
      name: "t3-code-no-headers",
      url: "http://127.0.0.1:4000",
    });
    expect("headers" in httpNoHeaders && httpNoHeaders.headers).toEqual([]);

    // Stdio
    const stdioDaemon = toDaemonMcpServer({
      type: "stdio",
      name: "cli-tool",
      command: "/path/to/bin",
      args: ["--arg1"],
      env: [{ name: "FOO", value: "BAR" }],
    });
    expect(stdioDaemon).toEqual({
      name: "cli-tool",
      command: "/path/to/bin",
      args: ["--arg1"],
      env: [{ name: "FOO", value: "BAR" }],
      isolation: "session",
      alwaysLoad: true,
    });

    // Stdio with missing args/env defaults to []
    const stdioEmpty = toDaemonMcpServer({
      name: "cli-bare",
      command: "/bin/true",
    });
    expect("args" in stdioEmpty && stdioEmpty.args).toEqual([]);
    expect("env" in stdioEmpty && stdioEmpty.env).toEqual([]);
  });
});

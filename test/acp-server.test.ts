import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AcpServer } from "../src/acp/server.ts";
import type { Log } from "../src/log.ts";
import type { ServeSessionFactory } from "../src/serve/session.ts";

const mockLog: Log["Service"] = {
  debug: () => Effect.void,
  warn: () => Effect.void,
};

const mockSessions = {
  create: () => Effect.die(new Error("not implemented for unit test")),
} as unknown as ServeSessionFactory["Service"];

describe("AcpServer Effect handler", () => {
  const server = AcpServer.make({
    sessions: mockSessions,
    log: mockLog,
    emitNotification: () => Effect.void,
    clientRequest: () => Effect.die(new Error("not implemented")),
    fallbackModels: Effect.succeed([]),
  });

  test("initialize handshake returns valid ACP agent info and capabilities", async () => {
    const res = (await Effect.runPromise(server.handle("initialize", {}))) as {
      protocolVersion: number;
      agentInfo: { name: string; version: string };
      agentCapabilities: { loadSession: boolean };
    };

    expect(res.protocolVersion).toBe(1);
    expect(res.agentInfo.name).toBe("zcode-serve-acp");
    expect(res.agentCapabilities.loadSession).toBe(true);
  });

  test("auth/authenticate returns empty result (daemon owns credentials)", async () => {
    const res = await Effect.runPromise(server.handle("auth/authenticate", {}));
    expect(res).toEqual({});
  });

  test("session/unload succeeds on non-existent or existing sessions", async () => {
    const res = await Effect.runPromise(server.handle("session/unload", { sessionId: "unknown-123" }));
    expect(res).toEqual({});
  });

  test("unknown method fails with AcpMethodError", async () => {
    const result = await Effect.runPromise(server.handle("nonexistent/method", {}).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AcpMethodError");
      expect(result.failure.message).toContain("unsupported ACP method");
    }
  });
});

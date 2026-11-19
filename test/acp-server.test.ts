import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AcpServer } from "../src/acp/server.ts";
import type { Log } from "../src/log.ts";
import type { AvailableModel, ServeSession, ServeSessionFactory } from "../src/serve/session.ts";

const mockLog: Log["Service"] = {
  debug: () => Effect.void,
  warn: () => Effect.void,
};

const sampleModels: AvailableModel[] = [
  {
    providerId: "zai-provider",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    providerLabel: "Z.AI Individual Coding Plan",
    reasoningLevels: [{ value: "max", label: "max" }],
    reasoningDefaultLevel: "max",
  },
];

const mockSessionInstance = {
  createSession: () =>
    Effect.succeed({
      models: sampleModels,
      currentModel: "zai-provider/GLM-5.3",
      skills: [],
      currentMode: "default",
    }),
  setMode: () => Effect.void,
  sendCommand: () => Effect.void,
  dispose: () => Effect.void,
} as unknown as ServeSession;

let createCalls = 0;
const mockSessions = {
  create: () => {
    createCalls++;
    return Effect.succeed(mockSessionInstance);
  },
} as unknown as ServeSessionFactory["Service"];

describe("AcpServer Effect handler", () => {
  const server = AcpServer.make({
    sessions: mockSessions,
    log: mockLog,
    emitNotification: () => Effect.void,
    clientRequest: () => Effect.die(new Error("not implemented")),
    fallbackModels: Effect.succeed(sampleModels),
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

  test("session/new, session/set_mode, session/cancel, and session/unload lifecycle", async () => {
    // 1. session/new
    const newRes = (await Effect.runPromise(
      server.handle("session/new", { cwd: "/tmp/workspace", sessionId: "sess-1" }),
    )) as { sessionId: string; models: { availableModels: unknown[] }; configOptions: unknown[] };

    expect(newRes.sessionId).toBe("sess-1");
    expect(newRes.models.availableModels.length).toBeGreaterThan(0);
    expect(createCalls).toBe(1);

    // 2. session/resume returns existing session without recreating
    const resumeRes = (await Effect.runPromise(
      server.handle("session/resume", { cwd: "/tmp/workspace", sessionId: "sess-1" }),
    )) as { sessionId: string };
    expect(resumeRes.sessionId).toBe("sess-1");
    expect(createCalls).toBe(1);

    // 3. session/set_mode
    const modeRes = await Effect.runPromise(server.handle("session/set_mode", { sessionId: "sess-1", modeId: "fast" }));
    expect(modeRes).toEqual({});

    // 4. session/cancel
    const cancelRes = await Effect.runPromise(server.handle("session/cancel", { sessionId: "sess-1" }));
    expect(cancelRes).toEqual({});

    // 5. session/unload
    const unloadRes = await Effect.runPromise(server.handle("session/unload", { sessionId: "sess-1" }));
    expect(unloadRes).toEqual({});
  });

  test("session/unload succeeds on non-existent sessions", async () => {
    const res = await Effect.runPromise(server.handle("session/unload", { sessionId: "unknown-999" }));
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

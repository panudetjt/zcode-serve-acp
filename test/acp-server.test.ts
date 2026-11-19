import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
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

  test("session/set_model and session/set_config_option (model, thought, mode, unknown)", async () => {
    await Effect.runPromise(server.handle("session/new", { sessionId: "config-sess" }));

    // 1. session/set_model
    const setModelRes = (await Effect.runPromise(
      server.handle("session/set_model", { sessionId: "config-sess", modelId: "zai-provider/GLM-5.3" }),
    )) as { configOptions: Array<{ id: string }> };
    expect(setModelRes.configOptions).toBeDefined();

    // 2. session/set_config_option: model
    const cfgModel = (await Effect.runPromise(
      server.handle("session/set_config_option", {
        sessionId: "config-sess",
        configId: "model",
        value: "zai-provider/GLM-5.3",
      }),
    )) as { configOptions: Array<{ id: string }> };
    expect(cfgModel.configOptions).toBeDefined();

    // 3. session/set_config_option: thought / reasoning
    const cfgThought = (await Effect.runPromise(
      server.handle("session/set_config_option", {
        sessionId: "config-sess",
        configId: "thought",
        value: "max",
      }),
    )) as { configOptions: Array<{ id: string }> };
    expect(cfgThought.configOptions).toBeDefined();

    // 4. session/set_config_option: mode
    const cfgMode = (await Effect.runPromise(
      server.handle("session/set_config_option", {
        sessionId: "config-sess",
        configId: "mode",
        value: "architect",
      }),
    )) as { configOptions: Array<{ id: string }> };
    expect(cfgMode.configOptions).toBeDefined();

    // 5. session/set_config_option: unknown option fails with AcpMethodError
    const errOpt = await Effect.runPromise(
      Effect.flip(
        server.handle("session/set_config_option", {
          sessionId: "config-sess",
          configId: "invalid_option",
          value: "foo",
        }),
      ),
    );
    expect(errOpt._tag).toBe("AcpMethodError");
    expect(errOpt.message).toContain("unknown config option");
  });

  test("session/prompt with turn lifecycle, interactions, frame updates, and lifecycle", async () => {
    let capturedHandlers: any;
    let clientRequests: Array<{ method: string; params: any }> = [];
    let notifications: Array<{ method: string; params: any }> = [];

    const mockSession = {
      createSession: () =>
        Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills: [{ name: "my-skill", description: "demo", path: "/skills/my-skill" }],
          currentMode: "default",
          slashCommands: [{ name: "help", description: "Show help" }],
        }),
      sendPrompt: () => Effect.succeed({ inputId: "inp-1" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      resolveInteraction: () => Effect.succeed({ resolved: true }),
      dispose: () => Effect.void,
    } as unknown as ServeSession;

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers;
          return Effect.succeed(mockSession);
        },
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: (method: string, params: unknown) =>
        Effect.sync(() => {
          notifications.push({ method, params });
        }),
      clientRequest: (method: string, params: unknown) =>
        Effect.sync(() => {
          clientRequests.push({ method, params });
          if (method === "elicitation/create") {
            return { action: "accept", content: { q0: "approved" } };
          }
          if (method === "session/request_permission") {
            return { outcome: { outcome: "accepted", optionId: "allow" } };
          }
          return {};
        }),
      fallbackModels: Effect.succeed(sampleModels),
    });

    // 1. session/new
    await Effect.runPromise(testServer.handle("session/new", { sessionId: "turn-sess" }));
    expect(capturedHandlers).toBeDefined();

    // 2. prompt with text, image, and /skill:<name> mention rewrite
    const promptFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: [
            { type: "text", text: "Please run /skill:my-skill on this image" },
            { type: "image", data: "base64data", mimeType: "image/png" },
            { type: "image", uri: "file:///local/path/img.png", mimeType: "image/jpeg" },
          ],
        }),
      ),
    );

    // Give prompt handler a moment to start turn
    await new Promise((r) => setTimeout(r, 20));

    // Simulate onConversationFrame with message update
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        topic: "conversation/turn-sess",
        control: { phase: "active" },
        text: "Hello from agent!",
      }),
    );

    // Simulate onConversationFrame with elicitation interaction
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                pendingInteractions: [
                  {
                    interactionId: "el-1",
                    kind: "userInput",
                    payload: { prompt: "Confirm?", toolName: "AskUserQuestion" },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    // Simulate onConversationFrame with permission interaction
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                pendingInteractions: [
                  {
                    interactionId: "perm-1",
                    kind: "permission",
                    payload: { toolName: "run_command", options: [{ optionId: "allow", label: "Allow" }] },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    // Simulate server request to onRequest handler
    const reqRes = await Effect.runPromise(
      capturedHandlers.onRequest("zcode", "requestPermission", {
        interactionId: "req-perm-1",
        toolName: "run_command",
        options: [{ optionId: "allow", label: "Allow" }],
      }),
    );
    expect(reqRes).toBeDefined();

    // Simulate unknown server request
    const unknownReqRes = await Effect.runPromise(capturedHandlers.onRequest("zcode", "unknownMethod", { foo: "bar" }));
    expect(unknownReqRes).toEqual({});

    // Complete the turn via onConversationFrame turnComplete
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" },
            },
          ],
        },
      }),
    );

    const promptResult = (await Effect.runPromise(Fiber.join(promptFiber))) as { stopReason: string };
    expect(promptResult.stopReason).toBe("end_turn");

    // 3. Test prompt turn failing with turnFailed
    const failFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: "Fail prompt",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 0, kind: "turnHeader", state: "error", error: "Fatal execution error" },
            },
          ],
        },
      }),
    );

    const failErr = await Effect.runPromise(Effect.flip(Fiber.join(failFiber)));
    expect(failErr._tag).toBe("AcpMethodError");
    expect(failErr.message).toContain("Turn execution failed");

    // 4. Test lifecycle handler: faulted state
    const lifeFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: "Lifecycle prompt",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    await Effect.runPromise(
      capturedHandlers.onLifecycle({
        state: "faulted",
        error: "daemon crashed",
      }),
    );

    const lifeErr = await Effect.runPromise(Effect.flip(Fiber.join(lifeFiber)));
    expect(lifeErr._tag).toBe("AcpMethodError");
    expect(lifeErr.message).toContain("daemon crashed");

    // 5. Test onClosed: closed before update
    const closedFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: "Closed prompt",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    await Effect.runPromise(capturedHandlers.onClosed("socket terminated"));

    const closedErr = await Effect.runPromise(Effect.flip(Fiber.join(closedFiber)));
    expect(closedErr._tag).toBe("AcpMethodError");
    expect(closedErr.message).toContain("Connection closed before response");
  });

  test("session/new falls back to fallbackModels when daemon advertises no models", async () => {
    const emptyModelsSession = {
      createSession: () =>
        Effect.succeed({
          models: [],
          skills: [],
        }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      dispose: () => Effect.void,
    } as unknown as ServeSession;

    const fallbackServer = AcpServer.make({
      sessions: {
        create: () => Effect.succeed(emptyModelsSession),
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.die("unused"),
      fallbackModels: Effect.succeed(sampleModels),
    });

    const res = (await Effect.runPromise(fallbackServer.handle("session/new", {}))) as {
      models: { availableModels: unknown[] };
    };
    expect(res.models.availableModels.length).toBe(1);
  });
});

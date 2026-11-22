import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { FileSystem } from "effect/FileSystem"
import { AcpServer } from "../src/acp/server.ts"
import type { McpServer } from "../src/acp/protocol.ts"
import { ClientRequestError } from "../src/errors.ts"
import { Log } from "../src/log.ts"
import { ServeSessionFactory, type AvailableModel, type ServeSession } from "../src/serve/session.ts"

const mockLog: Log["Service"] = {
  debug: () => Effect.void,
  warn: () => Effect.void,
  debugSync: () => {}
}

const sampleModels: AvailableModel[] = [
  {
    providerId: "zai-provider",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    providerLabel: "Z.AI Individual Coding Plan",
    reasoningLevels: [{ value: "max", label: "max" }],
    reasoningDefaultLevel: "max"
  }
]

const mockSessionInstance = {
  createSession: () =>
    Effect.succeed({
      models: sampleModels,
      currentModel: "zai-provider/GLM-5.3",
      skills: [],
      currentMode: "default"
    }),
  setMcpServers: () => Effect.void,
  sendPrompt: () => Effect.succeed({ inputId: "mock-inp" }),
  setMode: () => Effect.void,
  sendCommand: () => Effect.void,
  dispose: Effect.void
} as unknown as ServeSession

let createCalls = 0
const mockSessions = {
  create: () => {
    createCalls++
    return Effect.succeed(mockSessionInstance)
  }
} as unknown as ServeSessionFactory["Service"]

describe("AcpServer Effect handler", () => {
  const server = AcpServer.make({
    sessions: mockSessions,
    log: mockLog,
    emitNotification: () => Effect.void,
    clientRequest: () => Effect.die(new Error("not implemented")),
    fallbackModels: Effect.succeed(sampleModels)
  })

  test("initialize handshake returns valid ACP agent info and capabilities", async () => {
    const res = (await Effect.runPromise(server.handle("initialize", {}))) as {
      protocolVersion: number
      agentInfo: { name: string; version: string }
      agentCapabilities: { loadSession: boolean; mcpCapabilities?: { http: boolean; sse: boolean } }
    }

    expect(res.protocolVersion).toBe(1)
    expect(res.agentInfo.name).toBe("zcode-serve-acp")
    expect(res.agentCapabilities.loadSession).toBe(true)
    expect(res.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: true })
  })

  test("session/new and session/load accept mcpServers and pass them to ServeSession", async () => {
    let capturedCreateMcpServers: unknown
    let capturedSetMcpServers: unknown

    const mockSessionWithMcp = {
      createSession: (_modelSel: unknown, mcpServers?: readonly McpServer[]) => {
        capturedCreateMcpServers = mcpServers
        return Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills: [],
          currentMode: "default"
        })
      },
      setMcpServers: (mcpServers: readonly McpServer[]) => {
        capturedSetMcpServers = mcpServers
        return Effect.void
      },
      sendPrompt: () => Effect.succeed({ inputId: "mock-inp" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      dispose: Effect.void
    } as unknown as ServeSession

    const srv = AcpServer.make({
      sessions: {
        create: () => Effect.succeed(mockSessionWithMcp)
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.die(new Error("not implemented")),
      fallbackModels: Effect.succeed(sampleModels)
    })

    const mcpServers = [
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1:51234",
        headers: [{ name: "Authorization", value: "Bearer token-1" }]
      }
    ]

    // session/new passes mcpServers to createSession
    const newRes = (await Effect.runPromise(
      srv.handle("session/new", {
        cwd: "/tmp/workspace",
        sessionId: "sess-mcp-test",
        mcpServers
      })
    )) as { sessionId: string }

    expect(newRes.sessionId).toBe("sess-mcp-test")
    expect(capturedCreateMcpServers).toEqual(mcpServers)

    // session/load on existing session updates mcpServers via setMcpServers
    const updatedMcpServers = [
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1:59999",
        headers: [{ name: "Authorization", value: "Bearer token-2" }]
      }
    ]
    const loadRes = (await Effect.runPromise(
      srv.handle("session/load", {
        cwd: "/tmp/workspace",
        sessionId: "sess-mcp-test",
        mcpServers: updatedMcpServers
      })
    )) as { sessionId: string }

    expect(loadRes.sessionId).toBe("sess-mcp-test")
    expect(capturedSetMcpServers).toEqual(updatedMcpServers)

    // session/load with empty mcpServers clears mcpServers
    await Effect.runPromise(
      srv.handle("session/load", {
        cwd: "/tmp/workspace",
        sessionId: "sess-mcp-test",
        mcpServers: []
      })
    )
    expect(capturedSetMcpServers).toEqual([])
  })

  test("auth/authenticate returns empty result (daemon owns credentials)", async () => {
    const res = await Effect.runPromise(server.handle("auth/authenticate", {}))
    expect(res).toEqual({})
  })

  test("session/new, session/set_mode, session/cancel, and session/unload lifecycle", async () => {
    // 1. session/new
    const newRes = (await Effect.runPromise(
      server.handle("session/new", { cwd: "/tmp/workspace", sessionId: "sess-1" })
    )) as { sessionId: string; models: { availableModels: unknown[] }; configOptions: unknown[] }

    expect(newRes.sessionId).toBe("sess-1")
    expect(newRes.models.availableModels.length).toBeGreaterThan(0)
    expect(createCalls).toBe(1)

    // 2. session/resume returns existing session without recreating
    const resumeRes = (await Effect.runPromise(
      server.handle("session/resume", { cwd: "/tmp/workspace", sessionId: "sess-1" })
    )) as { sessionId: string }
    expect(resumeRes.sessionId).toBe("sess-1")
    expect(createCalls).toBe(1)

    // 3. session/set_mode
    const modeRes = await Effect.runPromise(server.handle("session/set_mode", { sessionId: "sess-1", modeId: "fast" }))
    expect(modeRes).toEqual({})

    // 4. session/cancel
    const cancelRes = await Effect.runPromise(server.handle("session/cancel", { sessionId: "sess-1" }))
    expect(cancelRes).toEqual({})

    // 5. session/unload
    const unloadRes = await Effect.runPromise(server.handle("session/unload", { sessionId: "sess-1" }))
    expect(unloadRes).toEqual({})
  })

  test("session/unload succeeds on non-existent sessions", async () => {
    const res = await Effect.runPromise(server.handle("session/unload", { sessionId: "unknown-999" }))
    expect(res).toEqual({})
  })

  test("emits available_commands_update on session/new, session/resume, and session/load", async () => {
    const emitted: Array<{ method: string; params: unknown }> = []
    const skills = [{ name: "test-skill", description: "A skill" }]
    const slashCommands = [{ name: "goal", description: "Set goal" }]
    const sessionWithSkills = {
      ...mockSessionInstance,
      createSession: () =>
        Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills,
          slashCommands,
          currentMode: "default"
        })
    } as unknown as ServeSession

    const cmdServer = AcpServer.make({
      sessions: { create: () => Effect.succeed(sessionWithSkills) } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: (method, params) =>
        Effect.sync(() => {
          emitted.push({ method, params })
        }),
      clientRequest: () => Effect.die("unused"),
      fallbackModels: Effect.succeed(sampleModels)
    })

    // 1. session/new emits available_commands_update
    await Effect.runPromise(cmdServer.handle("session/new", { sessionId: "cmd-sess" }))
    const newUpdates = emitted.filter(
      (e) =>
        e.method === "session/update" &&
        (e.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "available_commands_update"
    )
    expect(newUpdates.length).toBeGreaterThanOrEqual(1)
    expect(newUpdates[0]).toBeDefined()
    const newCommands = (newUpdates[0]!.params as { update: { availableCommands: Array<{ name: string }> } }).update
      .availableCommands
    expect(newCommands.some((c) => c.name === "goal")).toBe(true)
    expect(newCommands.some((c) => c.name === "$test-skill")).toBe(true)

    // 2. session/resume on existing bridge also emits available_commands_update
    emitted.length = 0
    await Effect.runPromise(cmdServer.handle("session/resume", { sessionId: "cmd-sess" }))
    const resumeUpdates = emitted.filter(
      (e) =>
        e.method === "session/update" &&
        (e.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "available_commands_update"
    )
    expect(resumeUpdates.length).toBeGreaterThanOrEqual(1)
    expect(resumeUpdates[0]).toBeDefined()
    const resumeCommands = (resumeUpdates[0]!.params as { update: { availableCommands: Array<{ name: string }> } })
      .update.availableCommands
    expect(resumeCommands.some((c) => c.name === "goal")).toBe(true)
    expect(resumeCommands.some((c) => c.name === "$test-skill")).toBe(true)

    // 3. session/load on existing bridge also emits available_commands_update
    emitted.length = 0
    await Effect.runPromise(cmdServer.handle("session/load", { sessionId: "cmd-sess" }))
    const loadUpdates = emitted.filter(
      (e) =>
        e.method === "session/update" &&
        (e.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "available_commands_update"
    )
    expect(loadUpdates.length).toBeGreaterThanOrEqual(1)
    expect(loadUpdates[0]).toBeDefined()
    const loadCommands = (loadUpdates[0]!.params as { update: { availableCommands: Array<{ name: string }> } }).update
      .availableCommands
    expect(loadCommands.some((c) => c.name === "goal")).toBe(true)
    expect(loadCommands.some((c) => c.name === "$test-skill")).toBe(true)

    // 4. session/prompt turn start also emits available_commands_update
    emitted.length = 0
    await Effect.runPromise(
      Effect.forkDetach(
        cmdServer.handle("session/prompt", { sessionId: "cmd-sess", prompt: [{ type: "text", text: "hello" }] })
      )
    )
    await new Promise((r) => setTimeout(r, 20))
    const promptUpdates = emitted.filter(
      (e) =>
        e.method === "session/update" &&
        (e.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "available_commands_update"
    )
    expect(promptUpdates.length).toBeGreaterThanOrEqual(1)
    expect(promptUpdates[0]).toBeDefined()
    const promptCommands = (promptUpdates[0]!.params as { update: { availableCommands: Array<{ name: string }> } })
      .update.availableCommands
    expect(promptCommands.some((c) => c.name === "goal")).toBe(true)
    expect(promptCommands.some((c) => c.name === "$test-skill")).toBe(true)
  })

  test("unknown method fails with AcpMethodError", async () => {
    const result = await Effect.runPromise(server.handle("nonexistent/method", {}).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("AcpMethodError")
      expect(result.failure.message).toContain("unsupported ACP method")
    }
  })

  test("session/set_model and session/set_config_option (model, thought, mode, unknown)", async () => {
    await Effect.runPromise(server.handle("session/new", { sessionId: "config-sess" }))

    // 1. session/set_model
    const setModelRes = (await Effect.runPromise(
      server.handle("session/set_model", { sessionId: "config-sess", modelId: "zai-provider/GLM-5.3" })
    )) as { configOptions: Array<{ id: string }> }
    expect(setModelRes.configOptions).toBeDefined()

    // 2. session/set_config_option: model
    const cfgModel = (await Effect.runPromise(
      server.handle("session/set_config_option", {
        sessionId: "config-sess",
        configId: "model",
        value: "zai-provider/GLM-5.3"
      })
    )) as { configOptions: Array<{ id: string }> }
    expect(cfgModel.configOptions).toBeDefined()

    // 3. session/set_config_option: thought / reasoning
    const cfgThought = (await Effect.runPromise(
      server.handle("session/set_config_option", {
        sessionId: "config-sess",
        configId: "thought",
        value: "max"
      })
    )) as { configOptions: Array<{ id: string }> }
    expect(cfgThought.configOptions).toBeDefined()

    // 4. session/set_config_option: mode
    const cfgMode = (await Effect.runPromise(
      server.handle("session/set_config_option", {
        sessionId: "config-sess",
        configId: "mode",
        value: "architect"
      })
    )) as { configOptions: Array<{ id: string }> }
    expect(cfgMode.configOptions).toBeDefined()

    // 5. session/set_config_option: unknown option fails with AcpMethodError
    const errOpt = await Effect.runPromise(
      Effect.flip(
        server.handle("session/set_config_option", {
          sessionId: "config-sess",
          configId: "invalid_option",
          value: "foo"
        })
      )
    )
    expect(errOpt._tag).toBe("AcpMethodError")
    expect(errOpt.message).toContain("unknown config option")
  })

  test("session/prompt with turn lifecycle, interactions, frame updates, and lifecycle", async () => {
    let capturedHandlers: any
    let clientRequests: Array<{ method: string; params: any }> = []
    let notifications: Array<{ method: string; params: any }> = []

    const mockSession = {
      createSession: () =>
        Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills: [{ name: "my-skill", description: "demo", path: "/skills/my-skill" }],
          currentMode: "default",
          slashCommands: [{ name: "help", description: "Show help" }]
        }),
      sendPrompt: () => Effect.succeed({ inputId: "inp-1" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      resolveInteraction: () => Effect.succeed({ resolved: true }),
      dispose: Effect.void
    } as unknown as ServeSession

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSession)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: (method: string, params: unknown) =>
        Effect.sync(() => {
          notifications.push({ method, params })
        }),
      clientRequest: (method: string, params: unknown) =>
        Effect.sync(() => {
          clientRequests.push({ method, params })
          if (method === "elicitation/create") {
            return { action: "accept", content: { q0: "approved" } }
          }
          if (method === "session/request_permission") {
            return { outcome: { outcome: "accepted", optionId: "allow" } }
          }
          return {}
        }),
      fallbackModels: Effect.succeed(sampleModels)
    })

    // 1. session/new
    await Effect.runPromise(testServer.handle("session/new", { sessionId: "turn-sess" }))
    expect(capturedHandlers).toBeDefined()

    // 2. prompt with text, image, and /skill:<name> mention rewrite
    const promptFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: [
            { type: "text", text: "Please run /skill:my-skill on this image" },
            { type: "image", data: "base64data", mimeType: "image/png" },
            { type: "image", uri: "file:///local/path/img.png", mimeType: "image/jpeg" }
          ]
        })
      )
    )

    // Give prompt handler a moment to start turn
    await new Promise((r) => setTimeout(r, 20))

    // Simulate onConversationFrame with message update
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        topic: "conversation/turn-sess",
        control: { phase: "active" },
        text: "Hello from agent!"
      })
    )

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
                    payload: { prompt: "Confirm?", toolName: "AskUserQuestion" }
                  }
                ]
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))

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
                    payload: { toolName: "run_command", options: [{ optionId: "allow", label: "Allow" }] }
                  }
                ]
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))

    // Simulate server request to onRequest handler
    const reqRes = await Effect.runPromise(
      capturedHandlers.onRequest("zcode", "requestPermission", {
        interactionId: "req-perm-1",
        toolName: "run_command",
        options: [{ optionId: "allow", label: "Allow" }]
      })
    )
    expect(reqRes).toBeDefined()

    // Simulate unknown server request
    const unknownReqRes = await Effect.runPromise(capturedHandlers.onRequest("zcode", "unknownMethod", { foo: "bar" }))
    expect(unknownReqRes).toEqual({})

    // Complete the turn via onConversationFrame turnComplete
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" }
            }
          ]
        }
      })
    )

    const promptResult = (await Effect.runPromise(Fiber.join(promptFiber))) as { stopReason: string }
    expect(promptResult.stopReason).toBe("end_turn")

    // 3. Test prompt turn failing with turnFailed
    const failFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: "Fail prompt"
        })
      )
    )
    await new Promise((r) => setTimeout(r, 20))

    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 0, kind: "turnHeader", state: "error", error: "Fatal execution error" }
            }
          ]
        }
      })
    )

    const failErr = await Effect.runPromise(Effect.flip(Fiber.join(failFiber)))
    expect(failErr._tag).toBe("AcpMethodError")
    expect(failErr.message).toContain("Turn execution failed")

    // 4. Test lifecycle handler: faulted state
    const lifeFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: "Lifecycle prompt"
        })
      )
    )
    await new Promise((r) => setTimeout(r, 20))

    await Effect.runPromise(
      capturedHandlers.onLifecycle({
        state: "faulted",
        error: "daemon crashed"
      })
    )

    const lifeErr = await Effect.runPromise(Effect.flip(Fiber.join(lifeFiber)))
    expect(lifeErr._tag).toBe("AcpMethodError")
    expect(lifeErr.message).toContain("daemon crashed")

    // 5. Test onClosed: closed before update
    const closedFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", {
          sessionId: "turn-sess",
          prompt: "Closed prompt"
        })
      )
    )
    await new Promise((r) => setTimeout(r, 20))

    await Effect.runPromise(capturedHandlers.onClosed("socket terminated"))

    const closedErr = await Effect.runPromise(Effect.flip(Fiber.join(closedFiber)))
    expect(closedErr._tag).toBe("AcpMethodError")
    expect(closedErr.message).toContain("Connection closed before response")
  })

  test("session/new falls back to fallbackModels when daemon advertises no models", async () => {
    const emptyModelsSession = {
      createSession: () =>
        Effect.succeed({
          models: [],
          skills: []
        }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      dispose: Effect.void
    } as unknown as ServeSession

    const fallbackServer = AcpServer.make({
      sessions: {
        create: () => Effect.succeed(emptyModelsSession)
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.die("unused"),
      fallbackModels: Effect.succeed(sampleModels)
    })

    const res = (await Effect.runPromise(fallbackServer.handle("session/new", {}))) as {
      models: { availableModels: unknown[] }
    }
    expect(res.models.availableModels.length).toBe(1)
  })

  test("layerNoDeps constructs an AcpServer using environment services", async () => {
    const layer = AcpServer.layerNoDeps
    const testEffect = Effect.gen(function* () {
      const s = yield* AcpServer
      const res = yield* s.handle("initialize", {})
      return res
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(ServeSessionFactory, mockSessions),
      Effect.provideService(Log, mockLog),
      Effect.provideService(FileSystem, {
        readFileString: () => Effect.fail(new Error("ENOENT"))
      } as unknown as FileSystem)
    )
    const result = await Effect.runPromise(testEffect)
    expect(result).toBeDefined()
  })

  test("tolerates failures in session/set_mode, set_config_option mode, and session/cancel", async () => {
    const failingSession = {
      createSession: () =>
        Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills: [],
          currentMode: "default"
        }),
      setMode: () => Effect.fail(new Error("setMode rejected")),
      sendCommand: () => Effect.fail(new Error("stop rejected")),
      setMcpServers: () => Effect.fail(new Error("setMcpServers rejected")),
      dispose: Effect.void
    } as unknown as ServeSession

    const s = AcpServer.make({
      sessions: {
        create: () => Effect.succeed(failingSession)
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.die("unused"),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(s.handle("session/new", { sessionId: "fail-sess" }))

    // 0. session/load with mcpServers failure tolerated
    const loadMcpRes = await Effect.runPromise(
      s.handle("session/load", {
        sessionId: "fail-sess",
        mcpServers: [{ type: "http", name: "t3-fail", url: "http://localhost:3000" }]
      })
    )
    expect(loadMcpRes).toBeDefined()

    // 1. session/set_mode failure tolerated
    const modeRes = await Effect.runPromise(s.handle("session/set_mode", { sessionId: "fail-sess", modeId: "fast" }))
    expect(modeRes).toEqual({})

    // 2. session/set_config_option mode failure tolerated
    const cfgModeRes = await Effect.runPromise(
      s.handle("session/set_config_option", { sessionId: "fail-sess", configId: "mode", value: "fast" })
    )
    expect(cfgModeRes).toBeDefined()

    // 3. session/cancel stop failure tolerated
    const cancelRes = await Effect.runPromise(s.handle("session/cancel", { sessionId: "fail-sess" }))
    expect(cancelRes).toEqual({})

    // 4. session/set_model with modelId without slash
    const modelRes = await Effect.runPromise(
      s.handle("session/set_model", { sessionId: "fail-sess", modelId: "GLM-5.3" })
    )
    expect(modelRes).toBeDefined()

    // 5. unknown session id in getSession fails with AcpMethodError
    const unknownErr = await Effect.runPromise(
      Effect.flip(s.handle("session/set_mode", { sessionId: "nonexistent", modeId: "fast" }))
    )
    expect(unknownErr._tag).toBe("AcpMethodError")
    expect(unknownErr.message).toContain("unknown session nonexistent")
  })

  test("handles interaction clientRequest rejections with fallbacks", async () => {
    let capturedHandlers: any
    const resolvedInteractions: Array<{ id: string; resolve: any }> = []

    const mockSession = {
      createSession: () =>
        Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills: [],
          currentMode: "default"
        }),
      sendPrompt: () => Effect.succeed({ inputId: "inp-2" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      resolveInteraction: (id: string, resolve: any) =>
        Effect.sync(() => {
          resolvedInteractions.push({ id, resolve })
        }),
      dispose: Effect.void
    } as unknown as ServeSession

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSession)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.fail(new ClientRequestError({ message: "Client rejected request" })),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(testServer.handle("session/new", { sessionId: "reject-sess" }))

    // Start turn
    const turnFiber = await Effect.runPromise(
      Effect.forkDetach(testServer.handle("session/prompt", { sessionId: "reject-sess", prompt: "Hello" }))
    )
    await new Promise((r) => setTimeout(r, 20))

    // 1. Elicitation interaction fails -> resolves with cancel
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
                    interactionId: "el-fail-1",
                    kind: "userInput",
                    payload: { prompt: "Confirm?", toolName: "AskUserQuestion" }
                  }
                ]
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))

    // 2. Permission interaction fails -> resolves with fallback allow
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
                    interactionId: "perm-fail-1",
                    kind: "permission",
                    payload: { toolName: "run_command", options: [{ optionId: "allow_opt", label: "Allow" }] }
                  }
                ]
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))

    // 3. Server request permission fails -> returns allow option
    const srvReqRes = await Effect.runPromise(
      capturedHandlers.onRequest("zcode", "requestPermission", {
        interactionId: "req-fail-1",
        toolName: "run_command",
        options: [{ optionId: "allow_opt", label: "Allow" }]
      })
    )
    expect(srvReqRes).toEqual({ interactionId: "req-fail-1", answer: { optionId: "allow_opt", label: "Allow" } })

    // 4. Lifecycle stopping ends turn
    await Effect.runPromise(capturedHandlers.onLifecycle({ state: "stopping" }))
    const result = (await Effect.runPromise(Fiber.join(turnFiber))) as { stopReason: string }
    expect(result.stopReason).toBe("end_turn")

    expect(resolvedInteractions.some((r) => r.id === "el-fail-1" && r.resolve.action === "cancel")).toBe(true)
    expect(resolvedInteractions.some((r) => r.id === "perm-fail-1" && r.resolve.optionId === "allow_opt")).toBe(true)
  })

  test("uses DEFAULT_ALLOW_OPTION_ID when permission options are empty", async () => {
    let capturedHandlers: any
    const resolvedInteractions: Array<{ id: string; resolve: any }> = []
    const mockSession = {
      ...mockSessionInstance,
      resolveInteraction: (id: string, resolve: any) =>
        Effect.sync(() => {
          resolvedInteractions.push({ id, resolve })
        })
    } as unknown as ServeSession

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSession)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.fail(new ClientRequestError({ message: "Client rejected" })),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(testServer.handle("session/new", { sessionId: "empty-opts-sess" }))

    const turnFiber = await Effect.runPromise(
      Effect.forkDetach(testServer.handle("session/prompt", { sessionId: "empty-opts-sess", prompt: "Go" }))
    )
    await new Promise((r) => setTimeout(r, 20))

    // 1. Permission interaction with empty options -> fallback resolves with allow_once
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
                    interactionId: "perm-empty-1",
                    kind: "permission",
                    payload: { toolName: "run_command", options: [] }
                  }
                ]
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))

    // 2. Server request permission with empty options -> returns allow_once fallback
    const srvReqRes = await Effect.runPromise(
      capturedHandlers.onRequest("zcode", "requestPermission", {
        interactionId: "req-empty-1",
        toolName: "run_command",
        options: []
      })
    )
    expect(srvReqRes).toEqual({ interactionId: "req-empty-1", answer: { optionId: "allow_once" } })

    // 3. End turn
    await Effect.runPromise(capturedHandlers.onLifecycle({ state: "stopping" }))
    const result = (await Effect.runPromise(Fiber.join(turnFiber))) as { stopReason: string }
    expect(result.stopReason).toBe("end_turn")

    // Verify the frame-driven permission fallback also used allow_once
    expect(resolvedInteractions.some((r) => r.id === "perm-empty-1" && r.resolve.optionId === "allow_once")).toBe(true)
  })

  test("handles turn cancellation and assistant settled quiet window in frames", async () => {
    let capturedHandlers: any
    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSessionInstance)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.die("unused"),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(testServer.handle("session/new", { sessionId: "quiet-sess" }))

    // 1. Turn cancelled via frame
    const cancelFiber = await Effect.runPromise(
      Effect.forkDetach(testServer.handle("session/prompt", { sessionId: "quiet-sess", prompt: "Cancel me" }))
    )
    await new Promise((r) => setTimeout(r, 20))

    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: { rowId: 10, kind: "turnHeader", state: "cancelled" }
            }
          ]
        }
      })
    )

    const cancelResult = (await Effect.runPromise(Fiber.join(cancelFiber))) as { stopReason: string }
    expect(cancelResult.stopReason).toBe("cancelled")

    // 2. Assistant settled arms quiet window, subsequent update clears quiet
    const quietFiber = await Effect.runPromise(
      Effect.forkDetach(testServer.handle("session/prompt", { sessionId: "quiet-sess", prompt: "Quiet test" }))
    )
    await new Promise((r) => setTimeout(r, 20))

    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 1, kind: "assistantText", text: "Hello", state: "complete" }
            }
          ]
        }
      })
    )

    // Another update clears quiet
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 2, kind: "assistantText", text: "More text" }
            }
          ]
        }
      })
    )

    // Complete turn
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" }
            }
          ]
        }
      })
    )

    const quietResult = (await Effect.runPromise(Fiber.join(quietFiber))) as { stopReason: string }
    expect(quietResult.stopReason).toBe("end_turn")
  })

  test("subagent drill-down: child subscription, batch summary, and settle unsubscribe", async () => {
    let capturedHandlers: any
    const notifications: Array<{ method: string; params: any }> = []
    const subscribedChildren: string[] = []
    const unsubscribedChildren: string[] = []
    let listSubagentsCalls = 0

    const mockSession = {
      createSession: () => Effect.succeed({ models: sampleModels, skills: [], raw: undefined }),
      sendPrompt: () => Effect.succeed({ inputId: "inp-sub" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      resolveInteraction: () => Effect.succeed({ resolved: true }),
      listSubagents: () => {
        listSubagentsCalls += 1
        return Effect.succeed({
          revision: 2,
          running: [
            {
              childSessionId: "child-x",
              toolCallId: "agent-tc-1",
              subagentType: "Explore",
              title: "Scan",
              status: "running"
            }
          ],
          ended: {
            total: 1,
            items: [{ childSessionId: "child-0", subagentType: "general", title: "Old", status: "success" }]
          }
        })
      },
      subscribeChild: (childSessionId: string) =>
        Effect.sync(() => {
          subscribedChildren.push(childSessionId)
        }),
      unsubscribeChild: (childSessionId: string) =>
        Effect.sync(() => {
          unsubscribedChildren.push(childSessionId)
        }),
      dispose: Effect.void
    } as unknown as ServeSession

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSession)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: (method: string, params: unknown) =>
        Effect.sync(() => {
          notifications.push({ method, params })
        }),
      clientRequest: () => Effect.fail(new ClientRequestError({ message: "no client" })),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(testServer.handle("session/new", { sessionId: "sub-sess" }))

    const promptFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", { sessionId: "sub-sess", prompt: [{ type: "text", text: "go" }] })
      )
    )
    await new Promise((r) => setTimeout(r, 20))

    // Subagent row with a childSessionId → subscribeChild + armed summary.
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 10,
                kind: "subagent",
                subagentType: "Explore",
                status: "running",
                summaryText: "Scanning",
                parentToolCallId: "agent-tc-1",
                childSessionId: "child-x"
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(subscribedChildren).toEqual(["child-x"])

    // Debounce window (1.5s) → listSubagents → one batch-summary content chunk.
    await new Promise((r) => setTimeout(r, 1800))
    expect(listSubagentsCalls).toBe(1)
    const summaries = notifications.filter(
      (n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "agent_message_chunk"
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.params.update.content.text).toContain("Subagents — 1 running, 1 done")
    expect(summaries[0]!.params.update.content.text).toContain("▸ Explore: Scan")

    // Settle the child → unsubscribe (and a second summary refresh armed).
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.upserted",
              row: {
                rowId: 10,
                kind: "subagent",
                subagentType: "Explore",
                status: "success",
                summaryText: "Scanning done",
                parentToolCallId: "agent-tc-1",
                childSessionId: "child-x"
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(unsubscribedChildren).toEqual(["child-x"])

    // End the turn.
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" } }]
        }
      })
    )
    const promptResult = (await Effect.runPromise(Fiber.join(promptFiber))) as { stopReason: string }
    expect(promptResult.stopReason).toBe("end_turn")
  })

  test("subagent summary skips when the turn ended during the debounce window", async () => {
    let capturedHandlers: any
    const notifications: Array<{ method: string; params: any }> = []
    const subscribed: string[] = []
    let listSubagentsCalls = 0

    const mockSession = {
      createSession: () => Effect.succeed({ models: sampleModels, skills: [], raw: undefined }),
      sendPrompt: () => Effect.succeed({ inputId: "inp-e1" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      resolveInteraction: () => Effect.succeed({ resolved: true }),
      listSubagents: () => {
        listSubagentsCalls += 1
        return Effect.succeed({ revision: 0, running: [], ended: { total: 0, items: [] } })
      },
      subscribeChild: (childSessionId: string) =>
        childSessionId === "child-bad"
          ? Effect.fail(new Error("subscribe refused"))
          : Effect.sync(() => subscribed.push(childSessionId)),
      unsubscribeChild: () => Effect.void,
      dispose: Effect.void
    } as unknown as ServeSession

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSession)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: (method: string, params: unknown) =>
        Effect.sync(() => {
          notifications.push({ method, params })
        }),
      clientRequest: () => Effect.fail(new ClientRequestError({ message: "no client" })),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(testServer.handle("session/new", { sessionId: "sub-edge-1" }))
    const promptFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", { sessionId: "sub-edge-1", prompt: [{ type: "text", text: "go" }] })
      )
    )
    await new Promise((r) => setTimeout(r, 20))

    // Two children in one sighting: the second arm hits the debounce guard;
    // the failing subscribe lands in tolerate's logged onFail.
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 11,
                kind: "subagent",
                subagentType: "Explore",
                status: "running",
                summaryText: "A",
                parentToolCallId: "tc-a",
                childSessionId: "child-y"
              }
            },
            {
              op: "row.appended",
              row: {
                rowId: 12,
                kind: "subagent",
                subagentType: "general",
                status: "running",
                summaryText: "B",
                parentToolCallId: "tc-b",
                childSessionId: "child-bad"
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(subscribed).toEqual(["child-y"])

    // Turn ends while the summary debounce is pending → the fiber wakes, sees
    // no turn, and skips the RPC entirely.
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" } }]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 1700))
    expect(listSubagentsCalls).toBe(0)
    expect(
      notifications.filter(
        (n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "agent_message_chunk"
      )
    ).toEqual([])
    const promptResult = (await Effect.runPromise(Fiber.join(promptFiber))) as { stopReason: string }
    expect(promptResult.stopReason).toBe("end_turn")
  }, 20_000)

  test("summary tolerates listSubagents failure, cross-fills bindings, and onChildFrame emits card updates", async () => {
    let capturedHandlers: any
    const notifications: Array<{ method: string; params: any }> = []
    const subscribed: string[] = []
    let listSubagentsCalls = 0
    let listMode: "fail" | "bindable" = "fail"

    const mockSession = {
      createSession: () => Effect.succeed({ models: sampleModels, skills: [], raw: undefined }),
      sendPrompt: () => Effect.succeed({ inputId: "inp-e2" }),
      setMode: () => Effect.void,
      sendCommand: () => Effect.void,
      resolveInteraction: () => Effect.succeed({ resolved: true }),
      listSubagents: () => {
        listSubagentsCalls += 1
        if (listMode === "fail") return Effect.fail(new Error("rpc down"))
        return Effect.succeed({
          revision: 1,
          running: [
            {
              childSessionId: "child-bind",
              toolCallId: "tc-x",
              subagentType: "general",
              title: "Bind me",
              status: "running"
            }
          ],
          ended: { total: 0, items: [] }
        })
      },
      subscribeChild: (childSessionId: string) =>
        Effect.sync(() => {
          subscribed.push(childSessionId)
        }),
      unsubscribeChild: () => Effect.void,
      dispose: Effect.void
    } as unknown as ServeSession

    const testServer = AcpServer.make({
      sessions: {
        create: (_cwd: string, handlers: any) => {
          capturedHandlers = handlers
          return Effect.succeed(mockSession)
        }
      } as unknown as ServeSessionFactory["Service"],
      log: mockLog,
      emitNotification: (method: string, params: unknown) =>
        Effect.sync(() => {
          notifications.push({ method, params })
        }),
      clientRequest: () => Effect.fail(new ClientRequestError({ message: "no client" })),
      fallbackModels: Effect.succeed(sampleModels)
    })

    await Effect.runPromise(testServer.handle("session/new", { sessionId: "sub-edge-2" }))
    const promptFiber = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", { sessionId: "sub-edge-2", prompt: [{ type: "text", text: "go" }] })
      )
    )
    await new Promise((r) => setTimeout(r, 20))

    // A card the RPC can bind to, plus a child sighting → armed summary that
    // will hit the failing listSubagents.
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            { op: "row.appended", row: { rowId: 20, kind: "toolCall", toolCallId: "tc-x", title: "Task" } },
            {
              op: "row.appended",
              row: {
                rowId: 21,
                kind: "subagent",
                subagentType: "general",
                status: "running",
                summaryText: "Z",
                parentToolCallId: "tc-y",
                childSessionId: "child-z"
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 1700))
    expect(listSubagentsCalls).toBe(1)
    expect(
      notifications.filter(
        (n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "agent_message_chunk"
      )
    ).toEqual([])

    // Close turn 1 — one turn at a time, like a real client.
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" } }]
        }
      })
    )
    const promptResult1 = (await Effect.runPromise(Fiber.join(promptFiber))) as { stopReason: string }
    expect(promptResult1.stopReason).toBe("end_turn")

    // Second turn + sighting with a succeeding RPC → cross-fill binds the
    // child onto the tc-x card and emits the batch overview.
    const promptFiber2 = await Effect.runPromise(
      Effect.forkDetach(
        testServer.handle("session/prompt", { sessionId: "sub-edge-2", prompt: [{ type: "text", text: "go 2" }] })
      )
    )
    await new Promise((r) => setTimeout(r, 20))
    listMode = "bindable"
    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 22,
                kind: "subagent",
                subagentType: "general",
                status: "running",
                summaryText: "W",
                parentToolCallId: "tc-w",
                childSessionId: "child-w"
              }
            }
          ]
        }
      })
    )
    await new Promise((r) => setTimeout(r, 1700))
    expect(listSubagentsCalls).toBe(2)
    expect(subscribed).toContain("child-bind")
    const summaries = notifications.filter(
      (n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "agent_message_chunk"
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.params.update.content.text).toContain("Subagents — 1 running, 0 done")

    // onChildFrame: bound child frame → card update; unknown child → nothing.
    await Effect.runPromise(
      capturedHandlers.onChildFrame("child-bind", {
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.appended", row: { rowId: 1, kind: "assistantText", text: "hello" } }]
        }
      })
    )
    const cardUpdates = notifications.filter(
      (n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "tool_call_update"
    )
    expect(cardUpdates).toHaveLength(1)
    expect(cardUpdates[0]!.params.update.toolCallId).toBe("tc-x")
    const before = notifications.length
    await Effect.runPromise(capturedHandlers.onChildFrame("ghost", { payload: { kind: "deltas", deltas: [] } }))
    expect(notifications.length).toBe(before)

    await Effect.runPromise(
      capturedHandlers.onConversationFrame({
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" } }]
        }
      })
    )
    const promptResult2 = (await Effect.runPromise(Fiber.join(promptFiber2))) as { stopReason: string }
    expect(promptResult2.stopReason).toBe("end_turn")
  }, 20_000)
})

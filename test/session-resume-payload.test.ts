import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Effect, Layer } from "effect"
import { describe, expect, test } from "bun:test"
import { Log } from "../src/log.ts"
import { BridgeExit } from "../src/serve/bridge.ts"
import { Daemon } from "../src/serve/daemon.ts"
import { ServeSessionFactory } from "../src/serve/session.ts"
import { decodeRpcMessage, encodeRpcMessage, MSG } from "../src/serve/wire.ts"

/**
 * `resumeSession` carries the workspace flat, like createSession: the daemon's
 * handler reads `params.workspacePath` / `params.workspaceIdentity` itself
 * (server-core.js 3.19.1) and fails on a nested `workspace` object before it
 * logs anything — silently, because the Bridge tolerates the call.
 */
describe("ServeSession resumeSession payload", () => {
  // Recovery must never fire here — a fake that dies loudly (instead of
  // exiting the test process) keeps that honest.
  const fakeBridgeExit = BridgeExit.of({
    exit: (reason) => Effect.die(new Error(`BridgeExit requested in test: ${reason}`))
  })

  test("setMcpServers resumes with the session id, the workspace fields and the servers at the top level", async () => {
    const calls: Array<{ channel: string; method: string; arg: unknown }> = []
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]))
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg)
          const decoded = decodeRpcMessage(raw)
          if (decoded.header[0] !== MSG.Promise) return
          const id = decoded.header[1] as number
          const channel = decoded.header[2] as string
          const method = decoded.header[3] as string
          calls.push({ channel, method, arg: (decoded.body as unknown[])?.[0] })
          const result =
            channel === "project" && method === "saveProject"
              ? { project: { id: "p-resume" } }
              : channel === "zcode-session" && method === "createSession"
                ? {
                    sessionId: "daemon-sess-resume-1",
                    session: { sessionId: "daemon-sess-resume-1", mode: "plan" },
                    settings: {
                      model: {
                        current: { ref: { providerId: "zai", modelId: "glm-5" } },
                        available: [{ ref: { providerId: "zai", modelId: "glm-5" } }]
                      }
                    }
                  }
                : {}
          ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], result))
        }
      }
    })

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory
      const session = yield* factory.create("/ws/resume", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void
      })
      yield* session.createSession(undefined, undefined)
      yield* session.setMcpServers([{ type: "http", name: "t3-code", url: "http://127.0.0.1:4000" }])

      const resume = calls.find((call) => call.method === "resumeSession")
      expect(resume?.channel).toBe("zcode-session")
      expect(resume?.arg).toEqual({
        sessionId: "daemon-sess-resume-1",
        workspacePath: "/ws/resume",
        workspaceIdentity: "/ws/resume",
        mcpServers: [
          {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4000",
            headers: [],
            isolation: "session",
            alwaysLoad: true
          }
        ]
      })
      yield* session.dispose
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(
        Layer.succeed(Daemon, {
          connect: Effect.succeed({
            status: { host: "localhost", port: server.port ?? 0, state: "ready" },
            token: "tok",
            wsPath: "/ws"
          }),
          readStatus: Effect.succeed({ host: "localhost", port: server.port ?? 0, state: "ready" }),
          getCapability: () => Effect.succeed("cap")
        })
      ),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Log.layerQuiet),
      Effect.scoped
    )

    try {
      await Effect.runPromise(prog)
    } finally {
      server.stop(true)
    }
  })
})

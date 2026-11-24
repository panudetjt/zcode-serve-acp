import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { describe, expect, test } from "bun:test"
import { Log } from "../src/log.ts"
import { BridgeExit } from "../src/serve/bridge.ts"
import { Daemon } from "../src/serve/daemon.ts"
import { ServeSessionFactory, type ServeSession } from "../src/serve/session.ts"
import { decodeRpcMessage, encodeRpcMessage, MSG } from "../src/serve/wire.ts"

/**
 * The real ServeSession against a fake daemon socket: the session-id seam the
 * orphan tool-part recovery hangs on, and the runtime restart it asks for.
 */

// Recovery must never fire here — a fake that dies loudly (instead of exiting
// the test process) keeps that honest.
const fakeBridgeExit = BridgeExit.of({
  exit: (reason) => Effect.die(new Error(`BridgeExit requested in test: ${reason}`))
})

const DAEMON_SESSION = "daemon-sess-restart-1"
const CWD = "/ws/restart"
const WORKSPACE = { sessionId: DAEMON_SESSION, workspacePath: CWD, workspaceIdentity: CWD }

interface ServerCall {
  channel: string
  method: string
  arg: unknown
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

/** How the fake daemon answers the RPCs a runtime restart is made of. */
interface DaemonBehaviour {
  stop?: "reject"
  resume?: "reject"
  resubscribe?: "reject"
  unsubscribe?: "reject"
}

/** Runs `body` with a real session in front of a fake daemon. */
const run = async (
  behaviour: DaemonBehaviour,
  body: (helpers: { session: ServeSession; calls: ServerCall[] }) => Effect.Effect<void, unknown>
): Promise<void> => {
  const calls: ServerCall[] = []
  let subscriptions = 0
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
        const ok = (result: unknown) => ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], result))
        const refuse = (message: string) => ws.send(encodeRpcMessage([MSG.PromiseError, id], { message }))
        if (channel === "project" && method === "saveProject") {
          ok({ project: { id: "p-restart" } })
        } else if (channel === "zcode-session" && method === "createSession") {
          ok({
            sessionId: DAEMON_SESSION,
            session: { sessionId: DAEMON_SESSION, mode: "plan" },
            settings: {
              model: {
                current: { ref: { providerId: "zai", modelId: "glm-5" } },
                available: [{ ref: { providerId: "zai", modelId: "glm-5" } }]
              }
            }
          })
        } else if (method === "stopSessionRuntime") {
          if (behaviour.stop === "reject") refuse("lifecycle unsupported")
          else ok({ completed: true })
        } else if (channel === "zcode-session" && method === "resumeSession") {
          if (behaviour.resume === "reject") refuse("resume refused")
          else ok({ ok: true })
        } else if (method === "unsubscribeConversationV4" && behaviour.unsubscribe === "reject") {
          refuse("unsubscribe refused")
        } else if (method === "subscribeConversationV4" && ++subscriptions > 1) {
          if (behaviour.resubscribe === "reject") refuse("subscribe refused")
          else ok({ subscribed: true })
        } else {
          ok({})
        }
      }
    }
  })

  const prog = Effect.gen(function* () {
    const factory = yield* ServeSessionFactory
    const session = yield* factory.create(CWD, {
      onConversationFrame: () => Effect.void,
      onChildFrame: () => Effect.void,
      onLifecycle: () => Effect.void,
      onRequest: () => Effect.succeed(undefined),
      onClosed: () => Effect.void
    })
    yield* body({ session, calls })
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
}

const mcpInput = [{ type: "http" as const, name: "t3-code", url: "http://127.0.0.1:4000" }]
const daemonMcp = [
  { name: "t3-code", type: "http", url: "http://127.0.0.1:4000", headers: [], isolation: "session", alwaysLoad: true }
]
const RESTART_RPCS = ["stopSessionRuntime", "resumeSession", "unsubscribeConversationV4", "subscribeConversationV4"]
/** The RPCs of one runtime restart, in order (the first subscription belongs to createSession). */
const restartTrace = (calls: ServerCall[]): Array<string> =>
  calls
    .filter((call) => RESTART_RPCS.includes(call.method))
    .slice(1)
    .map((call) => call.method)

describe("ServeSession restartRuntime and getDaemonSessionId", () => {
  test("getDaemonSessionId is undefined until createSession, then names the daemon's session", async () => {
    await run({}, ({ session }) =>
      Effect.gen(function* () {
        expect(yield* session.getDaemonSessionId).toBeUndefined()
        yield* session.createSession(undefined, mcpInput)
        expect(yield* session.getDaemonSessionId).toBe(DAEMON_SESSION)
      })
    )
  })

  test("restartRuntime stops the runtime and resumes the session with the Client's MCP servers", async () => {
    await run({}, ({ session, calls }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, mcpInput)
        yield* session.restartRuntime

        expect(restartTrace(calls)).toEqual([
          "stopSessionRuntime",
          "resumeSession",
          "unsubscribeConversationV4",
          "subscribeConversationV4"
        ])
        const stop = calls.find((call) => call.method === "stopSessionRuntime")
        expect(stop?.channel).toBe("zcode-agent")
        expect(stop?.arg).toEqual(WORKSPACE)
        // Flat like createSession: the daemon reads workspacePath / workspaceIdentity at the top level.
        const resume = calls.find((call) => call.method === "resumeSession")
        expect(resume?.channel).toBe("zcode-session")
        expect(resume?.arg).toEqual({ ...WORKSPACE, mcpServers: daemonMcp })
        // A lifecycle restart is never asked for: it drops the Client's MCP servers.
        expect(calls.filter((call) => call.method === "restartSessionRuntime")).toHaveLength(0)
      })
    )
  })

  test("without MCP servers the resume carries none, and it is still what recreates the runtime", async () => {
    await run({}, ({ session, calls }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, undefined)
        yield* session.restartRuntime
        expect(restartTrace(calls)).toEqual([
          "stopSessionRuntime",
          "resumeSession",
          "unsubscribeConversationV4",
          "subscribeConversationV4"
        ])
        expect(calls.find((call) => call.method === "resumeSession")?.arg).toEqual(WORKSPACE)
      })
    )
  })

  test("a refused stop or a refused resume fails restartRuntime — a half-restarted session is never reported as restarted", async () => {
    await run({ stop: "reject" }, ({ session, calls }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, mcpInput)
        expect(String(errorOf(yield* Effect.exit(session.restartRuntime)))).toContain("lifecycle unsupported")
        // Nothing else is attempted once the stop is refused.
        expect(calls.filter((call) => call.method === "resumeSession")).toHaveLength(0)
      })
    )
    await run({ resume: "reject" }, ({ session }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, mcpInput)
        expect(String(errorOf(yield* Effect.exit(session.restartRuntime)))).toContain("resume refused")
      })
    )
  })

  test("a refused re-subscription fails restartRuntime instead of leaving the session deaf", async () => {
    await run({ resubscribe: "reject" }, ({ session, calls }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, undefined)
        expect(String(errorOf(yield* Effect.exit(session.restartRuntime)))).toContain("subscribe refused")
        expect(calls.filter((call) => call.method === "resumeSession")).toHaveLength(1)
      })
    )
  })

  test("a refused unsubscribe is best-effort: the conversation is registered again anyway", async () => {
    await run({ unsubscribe: "reject" }, ({ session, calls }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, undefined)
        yield* session.restartRuntime
        expect(restartTrace(calls)).toEqual([
          "stopSessionRuntime",
          "resumeSession",
          "unsubscribeConversationV4",
          "subscribeConversationV4"
        ])
      })
    )
  })

  test("restartRuntime before createSession fails with SessionError and calls nothing", async () => {
    await run({}, ({ session, calls }) =>
      Effect.gen(function* () {
        expect(String(errorOf(yield* Effect.exit(session.restartRuntime)))).toContain("no daemon session")
        expect(restartTrace(calls)).toEqual([])
      })
    )
  })
})

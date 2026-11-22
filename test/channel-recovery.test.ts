import { describe, expect, test } from "bun:test"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Deferred, Effect, Layer } from "effect"
import { DiscoveryError } from "../src/errors.ts"
import { Log } from "../src/log.ts"
import { BridgeExit } from "../src/serve/bridge.ts"
import { Daemon, type DaemonConnection, type ServerStatus } from "../src/serve/daemon.ts"
import { ServeSessionFactory } from "../src/serve/session.ts"
import { decodeRpcMessage, encodeRpcMessage, MSG } from "../src/serve/wire.ts"

/**
 * Issue #5 channel recovery: zombie channels, daemon restarts, and the
 * fail-fast fallback. Scenarios follow the issue's Testing Decisions —
 * behavior is verified at the session's public API over real local WebSocket
 * servers (the same harness as session.test.ts), never through private
 * fields.
 */

interface ServerCall {
  channel: string
  method: string
  arg?: unknown
}

/**
 * One fake daemon WS endpoint answering the full session workflow. When
 * `fireFrameOnSubscribe` is set, a conversation frame is pushed right after
 * the frame listener registers — proving frames flow again post-recovery.
 */
const makeDaemonServer = (calls: Array<ServerCall>, fireFrameOnSubscribe: boolean) => {
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
        const type = decoded.header[0]
        if (type === MSG.EventListen) {
          const event = decoded.header[3] as string
          if (event === "onDynamicConversationFrame" && fireFrameOnSubscribe) {
            ws.send(
              encodeRpcMessage([MSG.EventFire, decoded.header[1] as number], {
                topic: "conversation/daemon-sess-1",
                update: "post-recovery"
              })
            )
          }
          return
        }
        if (type !== MSG.Promise) return
        const id = decoded.header[1] as number
        const channel = decoded.header[2] as string
        const method = decoded.header[3] as string
        const arg = (decoded.body as unknown[])?.[0]
        calls.push({ channel, method, arg })
        const reply = (body: unknown) => ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], body))
        if (channel === "project" && method === "saveProject") reply({ project: { id: "proj-1" } })
        else if (channel === "zcode-agent" && method === "initialize") reply({ ok: true })
        else if (channel === "zcode-session" && method === "createSession") reply({ sessionId: "daemon-sess-1" })
        else if (channel === "zcode-agent" && method === "subscribeConversationV4") reply({ subscribed: true })
        // the issue #5 pre-flight probe target (server-core.js 3.19.0)
        else if (channel === "zcode-agent" && method === "helloConversationV4") reply({ hello: true })
        else if (channel === "zcode-agent" && method === "sendPrompt") reply({ ok: true })
        else if (channel === "skills" && method === "list") reply({ skills: [] })
        else reply({})
      }
    }
  })
  return server
}

const connectionTo = (host: string, port: number, pid: number, startedAt: number): DaemonConnection => ({
  status: { host, port, state: "ready", version: "3.19.0", pid, startedAt },
  token: "tok",
  wsPath: "/ws/host"
})

/**
 * Daemon fake whose connect hands out queued connections (a restart means a
 * new status: new pid/startedAt, usually a new port) and whose readStatus
 * serves the CURRENT status file through a holder the test mutates.
 */
const daemonFake = (
  connections: Array<DaemonConnection>,
  currentStatus: { value: ServerStatus | undefined },
  opts?: { connectFails?: { value: boolean } }
): Daemon["Service"] => ({
  connect: Effect.suspend(() => {
    if (opts?.connectFails?.value === true) {
      return Effect.fail(new DiscoveryError({ message: "daemon down" }))
    }
    const next = connections.shift() ?? connections[connections.length - 1]
    if (next === undefined) return Effect.fail(new DiscoveryError({ message: "no connection queued" }))
    return Effect.succeed(next)
  }),
  readStatus: Effect.sync(() => currentStatus.value),
  getCapability: () => Effect.succeed("cap")
})

const provideTestLayers = <A, E, R>(
  daemon: Daemon["Service"],
  bridgeExit: BridgeExit["Service"],
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.provide(ServeSessionFactory.layerNoDeps),
    Effect.provide(Layer.succeed(Daemon, daemon)),
    Effect.provide(Layer.succeed(BridgeExit, bridgeExit)),
    Effect.provide(BunSocket.layerWebSocketConstructor),
    Effect.provide(Log.layerQuiet),
    Effect.scoped
  )

describe("Channel recovery (issue #5)", () => {
  test("sendPrompt recovers across a daemon restart on a new port and frames keep flowing", async () => {
    const calls1: Array<ServerCall> = []
    const calls2: Array<ServerCall> = []
    const server1 = makeDaemonServer(calls1, false)
    const server2 = makeDaemonServer(calls2, true)

    const conn1 = connectionTo("localhost", server1.port ?? 0, 111, 1)
    const conn2 = connectionTo("localhost", server2.port ?? 0, 222, 2)
    const currentStatus: { value: ServerStatus | undefined } = { value: conn1.status }
    const daemon = daemonFake([conn1, conn2], currentStatus)

    const frames: Array<unknown> = []
    const frameDone = Deferred.makeUnsafe<void>()
    const closedReasons: Array<string> = []

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory
      const session = yield* factory.create("/test/workspace", {
        onConversationFrame: (frame) =>
          Effect.sync(() => {
            frames.push(frame)
            Deferred.doneUnsafe(frameDone, Effect.void)
          }),
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: (reason) =>
          Effect.sync(() => {
            closedReasons.push(reason)
          })
      })

      const created = yield* session.createSession(undefined, [
        {
          type: "http",
          name: "t3-code",
          url: "http://localhost:3000"
        }
      ])
      expect(created.daemonSessionId).toBe("daemon-sess-1")

      // The daemon "restarts": old process dies (socket half-opens then
      // closes without our involvement) and the status file now points at a
      // new pid/startedAt/port.
      server1.stop(true)
      currentStatus.value = conn2.status

      // The very next Turn must recover — never surface a transport error.
      const prompt = yield* session.sendPrompt("next turn after restart")
      expect(typeof prompt.inputId).toBe("string")

      // Re-subscription replays on the NEW daemon: fresh channel, fresh
      // listeners, and the pushed frame arrives through the new channel.
      yield* Deferred.await(frameDone).pipe(Effect.timeout("5 seconds"))
      expect((frames[frames.length - 1] as { update?: string }).update).toBe("post-recovery")

      // Recovery is transparent: the superseded channel's late close is
      // absorbed by the session (it never reaches the app handler), so the
      // Client's conversation just continues on the fresh channel.
      expect(closedReasons.length).toBe(0)
      yield* session.dispose
    })

    try {
      await Effect.runPromise(provideTestLayers(daemon, exitFake([]), prog))
    } finally {
      server2.stop(true)
    }

    // server2 saw the full re-attach workflow: capability-backed dial →
    // initialize replay → conversation re-subscribe → the prompt itself.
    const methods2 = calls2.map((c) => c.method)
    expect(methods2).toContain("resumeSession")
    const resumeCall = calls2.find((c) => c.method === "resumeSession")
    const resumeArg = resumeCall?.arg as { sessionId?: string; mcpServers?: unknown } | undefined
    expect(resumeArg?.sessionId).toBe("daemon-sess-1")
    expect(resumeArg?.mcpServers).toEqual([
      {
        name: "t3-code",
        type: "http",
        url: "http://localhost:3000",
        headers: [],
        isolation: "session",
        alwaysLoad: true
      }
    ])
    expect(methods2).toContain("subscribeConversationV4")
    expect(methods2).toContain("helloConversationV4")
    expect(methods2).toContain("sendConversationCommandV4")
  })

  test("watchdog invalidates a live channel when the status file reports a restarted daemon", async () => {
    const calls: Array<ServerCall> = []
    // The old daemon process keeps accepting sockets (channel NOT settled) —
    // only the status file's pid/startedAt reveal the restart.
    const server = makeDaemonServer(calls, false)

    const conn1 = connectionTo("localhost", server.port ?? 0, 111, 1)
    // The daemon restarted in place: same port, new process (pid/startedAt).
    const conn2 = connectionTo("localhost", server.port ?? 0, 222, 2)
    const currentStatus: { value: ServerStatus | undefined } = { value: conn1.status }
    const daemon = daemonFake([conn1, conn2], currentStatus)

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory
      const session = yield* factory.create("/test/workspace", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void
      })
      yield* session.createSession()
      const subscribeCallsBefore = calls.filter((c) => c.method === "subscribeConversationV4").length

      // Same port, same host — but a new daemon process answered the status
      // file (pid 111 → 222, startedAt 1 → 2).
      currentStatus.value = { ...conn1.status, pid: 222, startedAt: 2 }

      const prompt = yield* session.sendPrompt("after silent restart")
      expect(typeof prompt.inputId).toBe("string")

      // The stale channel was replaced: the conversation subscription ran
      // again on the fresh channel.
      const subscribeCallsAfter = calls.filter((c) => c.method === "subscribeConversationV4").length
      expect(subscribeCallsAfter).toBe(subscribeCallsBefore + 1)
      yield* session.dispose
    })

    try {
      await Effect.runPromise(provideTestLayers(daemon, exitFake([]), prog))
    } finally {
      server.stop(true)
    }
  })

  test("recovery budget exhaustion exits the Bridge (fail-fast fallback)", async () => {
    const exits: Array<string> = []
    const bridgeExit = BridgeExit.of({
      // The real layer exits the process; the fake dies with a marker so the
      // test can assert the fail-fast path fired.
      exit: (reason) =>
        Effect.gen(function* () {
          exits.push(reason)
          return yield* Effect.die(new Error(`BRIDGE_EXIT_TEST: ${reason}`))
        })
    })

    const calls: Array<ServerCall> = []
    const server = makeDaemonServer(calls, false)
    const conn1 = connectionTo("localhost", server.port ?? 0, 111, 1)
    const currentStatus: { value: ServerStatus | undefined } = { value: conn1.status }
    const connectFails = { value: false }
    const daemon = daemonFake([conn1], currentStatus, { connectFails })

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory
      const session = yield* factory.create("/test/workspace", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void
      })
      yield* session.createSession()

      // The daemon dies AND never comes back: socket gone, connect keeps
      // failing. The next Turn must fail fast (exit), not -32000 forever.
      server.stop(true)
      currentStatus.value = undefined
      connectFails.value = true

      yield* session.sendPrompt("doomed turn")
      throw new Error("sendPrompt should never return past the fail-fast exit")
    })

    const outcome = await Effect.runPromiseExit(provideTestLayers(daemon, bridgeExit, prog))
    expect(outcome._tag).toBe("Failure")
    expect(exits.length).toBe(1)
    expect(exits[0]).toContain("unreachable after 2 reconnect attempts")
  })
})

/** Placeholder swap so the first two tests stay honest: recovery must NOT exit. */
function exitFake(exits: Array<string>): BridgeExit["Service"] {
  return BridgeExit.of({
    exit: (reason) =>
      Effect.gen(function* () {
        exits.push(reason)
        return yield* Effect.die(new Error(`BRIDGE_EXIT_TEST (unexpected): ${reason}`))
      })
  })
}

import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Clock, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "bun:test"
import { Log } from "../src/log.ts"
import { BridgeExit } from "../src/serve/bridge.ts"
import { Daemon, type DaemonConnection } from "../src/serve/daemon.ts"
import { ServeSessionFactory, type ServeSession } from "../src/serve/session.ts"
import { decodeRpcMessage, encodeRpcMessage, MSG } from "../src/serve/wire.ts"

/**
 * Issue #26 — the Client's MCP servers must be in whatever runtime the
 * session's Turn runs on. The real ServeSession over a real local WebSocket,
 * against a fake daemon that keeps to what the daemon does with a runtime and
 * its MCP config (ZCode source v3.18.2 `session-lifecycle/controller.ts`,
 * `zcode-protocol/server-operations.ts`; server-core.js 4.0.0; re-verified
 * live on runtime 4.0.0 with scripts/probe-mcp-persist.ts):
 *
 *  - MCP servers are read once, when a runtime is created
 *    (`createRecord` → `runtimeConfig.mcp`).
 *  - `session/resume` on a LIVE runtime returns it untouched — the servers in
 *    its params are ignored.
 *  - a runtime is created WITHOUT servers by a subscribe or a command on a
 *    session whose runtime is gone (cold resume), by the resident pool
 *    bringing back an idle session, by a plugin reload, and by anything else
 *    that recreates it on the daemon's own initiative.
 *  - a command for a session whose runtime is gone is refused.
 *  - the lifecycle `generation` counts a session's runtimes within one daemon
 *    process; every creation increments it, and a restarted daemon counts
 *    from 1 again.
 */

const DAEMON_SESSION = "daemon-sess-mcp-1"
const CWD = "/ws/mcp"
/** The Client's server as the ACP `session/new` carries it — the same name on every launch, the definition not. */
const t3Code = (port: number) => [{ type: "http" as const, name: "t3-code", url: `http://127.0.0.1:${port}` }]
/** How the fake names that server once it is in a runtime. */
const inRuntime = (port: number) => [`t3-code@http://127.0.0.1:${port}`]

interface Call {
  channel: string
  method: string
  arg: unknown
}

interface Runtime {
  live: boolean
  /** Names of the MCP servers the runtime was created with. */
  mcp: string[]
  generation: number
}

/** Levers a test pulls to make the daemon misbehave; all default to "well-behaved". */
interface Behaviour {
  /** How many `resumeSession` calls to refuse ("resume refused") before answering. */
  resumeRefusals: number
  /** How many `stopSessionRuntime` calls to refuse before answering. */
  stopRefusals: number
  /** Answer `stopSessionRuntime` as if it worked but keep the runtime live. */
  stopIgnored: boolean
  /** Answer `getSessionLifecycle` with null, as the host does for a daemon that has no such call. */
  noLifecycle: boolean
  /** Answer `getSessionLifecycle` with `starting` this many times before the truth. */
  startingAnswers: number
  /** How many `getSessionLifecycle` calls to refuse ("lifecycle refused") before answering. */
  lifecycleRefusals: number
  /** How many `subscribeConversationV4` calls to refuse ("subscribe refused") before answering. */
  subscribeRefusals: number
  /** Omit the pid and start time from the status file, as a daemon that cannot identify itself. */
  anonymousStatus: boolean
  /** Answer `getSessionLifecycle` with `starting` for as long as set, whatever the runtime. */
  stuckStarting: boolean
  /** Hold every `getSessionLifecycle` answer this many ms — two callers then read the same past. */
  lifecycleHoldMs: number
}

interface FakeDaemon {
  readonly calls: Call[]
  readonly behaviour: Behaviour
  /** MCP servers of the runtime that accepted the last Turn. */
  readonly turnMcp: () => string[] | undefined
  readonly methods: () => string[]
  /** Another client's cold subscribe: creates the runtime, without any servers. */
  readonly coldActivate: () => void
  /** The resident pool unloading the session: the runtime is gone, the Bridge's channel is not. */
  readonly unload: () => void
  /** The daemon process restarts: every runtime is gone, the Bridge's channel closes, new pid/port. */
  readonly restart: () => void
  /** Only the Bridge's channel drops: the daemon and every runtime stay as they are. */
  readonly dropChannel: () => void
  readonly service: Daemon["Service"]
  readonly close: () => void
}

const serversOf = (arg: unknown): string[] => {
  const servers = (arg as { mcpServers?: Array<{ name: string; url?: string; command?: string }> } | undefined)
    ?.mcpServers
  return servers === undefined ? [] : servers.map((server) => `${server.name}@${server.url ?? server.command ?? ""}`)
}

const makeDaemon = (): FakeDaemon => {
  const calls: Call[] = []
  const behaviour: Behaviour = {
    resumeRefusals: 0,
    stopRefusals: 0,
    stopIgnored: false,
    noLifecycle: false,
    startingAnswers: 0,
    lifecycleRefusals: 0,
    subscribeRefusals: 0,
    anonymousStatus: false,
    stuckStarting: false,
    lifecycleHoldMs: 0
  }
  const runtime: Runtime = { live: false, mcp: [], generation: 0 }
  let turnMcp: string[] | undefined
  let pid = 111
  let startedAt = 1
  let server: ReturnType<typeof listen> | undefined
  const sockets = new Set<{ close: () => void }>()

  const snapshot = () => ({
    sessionId: DAEMON_SESSION,
    state: runtime.live ? "ready" : "unloaded",
    generation: runtime.generation,
    revision: runtime.generation * 2 + (runtime.live ? 0 : 1),
    lastError: null
  })
  const create = (mcp: string[]): void => {
    runtime.live = true
    runtime.mcp = mcp
    runtime.generation += 1
  }

  const listen = () =>
    Bun.serve({
      port: 0,
      fetch(req, upgraded) {
        if (upgraded.upgrade(req)) return
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        open(ws) {
          sockets.add(ws)
          ws.send(encodeRpcMessage([MSG.Initialize]))
        },
        close(ws) {
          sockets.delete(ws)
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg)
          const decoded = decodeRpcMessage(raw)
          if (decoded.header[0] !== MSG.Promise) return
          const id = decoded.header[1] as number
          const channel = decoded.header[2] as string
          const method = decoded.header[3] as string
          const arg = (decoded.body as unknown[])?.[0]
          calls.push({ channel, method, arg })
          const ok = (result: unknown) => ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], result))
          const refuse = (message: string) => ws.send(encodeRpcMessage([MSG.PromiseError, id], { message }))

          if (channel === "project" && method === "saveProject") {
            ok({ project: { id: "p-mcp" } })
          } else if (channel === "zcode-agent" && method === "initialize") {
            ok({ ok: true })
          } else if (channel === "zcode-agent" && method === "helloConversationV4") {
            ok({ hello: true })
          } else if (channel === "skills" && method === "list") {
            ok({ skills: [] })
          } else if (channel === "zcode-session" && method === "createSession") {
            create(serversOf(arg))
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
          } else if (channel === "zcode-session" && method === "resumeSession") {
            if (behaviour.resumeRefusals > 0) {
              behaviour.resumeRefusals -= 1
              refuse("resume refused")
            } else {
              // A live runtime is returned as it is; only a missing one is created.
              if (!runtime.live) create(serversOf(arg))
              ok({ ok: true })
            }
          } else if (channel === "zcode-agent" && method === "subscribeConversationV4") {
            if (behaviour.subscribeRefusals > 0) {
              behaviour.subscribeRefusals -= 1
              refuse("subscribe refused")
            } else {
              const visibility = (arg as { visibility?: string } | undefined)?.visibility
              if (visibility === "foreground" && !runtime.live) create([])
              ok({ subscribed: true })
            }
          } else if (channel === "zcode-agent" && method === "getSessionLifecycle") {
            const answer = () => {
              if (behaviour.lifecycleRefusals > 0) {
                behaviour.lifecycleRefusals -= 1
                refuse("lifecycle refused")
              } else if (behaviour.noLifecycle) ok(null)
              else if (behaviour.stuckStarting) ok({ ...snapshot(), state: "starting" })
              else if (behaviour.startingAnswers > 0) {
                behaviour.startingAnswers -= 1
                ok({ ...snapshot(), state: "starting" })
              } else ok(snapshot())
            }
            if (behaviour.lifecycleHoldMs > 0) setTimeout(answer, behaviour.lifecycleHoldMs)
            else answer()
          } else if (channel === "zcode-agent" && method === "stopSessionRuntime") {
            if (behaviour.stopRefusals > 0) {
              behaviour.stopRefusals -= 1
              refuse("stop refused")
            } else {
              if (!behaviour.stopIgnored) runtime.live = false
              ok({ completed: true })
            }
          } else if (
            (channel === "zcode-agent" && method === "sendConversationCommandV4") ||
            (channel === "zcode-agent" && method === "sendPrompt")
          ) {
            if (!runtime.live)
              refuse(method === "sendPrompt" ? "Session runtime is not ready" : "proto.sessionNotFound")
            else {
              turnMcp = [...runtime.mcp]
              ok(method === "sendPrompt" ? { ok: true } : { status: "accepted" })
            }
          } else {
            ok({})
          }
        }
      }
    })

  server = listen()
  const connectionOf = (): DaemonConnection => ({
    status: {
      host: "localhost",
      port: server?.port ?? 0,
      state: "ready",
      version: "4.0.0",
      ...(behaviour.anonymousStatus ? {} : { pid, startedAt })
    },
    token: "tok",
    wsPath: "/ws/host"
  })

  return {
    calls,
    behaviour,
    turnMcp: () => turnMcp,
    methods: () => calls.map((call) => call.method),
    coldActivate: () => {
      if (!runtime.live) create([])
      else {
        // a plugin reload: the live runtime is replaced by one without servers
        runtime.mcp = []
        runtime.generation += 1
      }
    },
    unload: () => {
      runtime.live = false
    },
    restart: () => {
      runtime.live = false
      runtime.generation = 0
      pid += 1
      startedAt += 1
      server?.stop(true)
      server = listen()
    },
    dropChannel: () => {
      for (const ws of sockets) ws.close()
    },
    service: {
      connect: Effect.suspend(() => Effect.succeed(connectionOf())),
      readStatus: Effect.sync(() => connectionOf().status),
      getCapability: () => Effect.succeed("cap")
    },
    close: () => server?.stop(true)
  }
}

// Recovery must never fire here — a fake that dies loudly (instead of exiting
// the test process) keeps that honest.
const fakeBridgeExit = BridgeExit.of({
  exit: (reason) => Effect.die(new Error(`BridgeExit requested in test: ${reason}`))
})

const makeLog = () => {
  const warnings: string[] = []
  const service = Log.of({
    debug: () => Effect.void,
    debugSync: () => undefined,
    warn: (...parts) =>
      Effect.sync(() => {
        warnings.push(parts.map((part) => (typeof part === "string" ? part : String(part))).join(" "))
      })
  })
  return { service, warnings }
}

interface Helpers {
  readonly session: ServeSession
  readonly daemon: FakeDaemon
  readonly warnings: string[]
  /** A clock the test turns itself: give it to one Turn (`Effect.provideService(Clock.Clock, clock)`) to run out a budget without waiting. */
  readonly clock: TestClock.TestClock
}

/**
 * Runs `body` with a real session in front of the fake daemon. The body's own
 * time is real; the test clock is only what a Turn is given.
 */
const run = async (body: (helpers: Helpers) => Effect.Effect<void, unknown>): Promise<void> => {
  const daemon = makeDaemon()
  const log = makeLog()
  const prog = Effect.gen(function* () {
    const factory = yield* ServeSessionFactory
    const clock = yield* TestClock.make()
    const session = yield* factory.create(CWD, {
      onConversationFrame: () => Effect.void,
      onChildFrame: () => Effect.void,
      onLifecycle: () => Effect.void,
      onRequest: () => Effect.succeed(undefined),
      onClosed: () => Effect.void
    })
    yield* body({ session, daemon, warnings: log.warnings, clock })
    yield* session.dispose
  }).pipe(
    Effect.provide(ServeSessionFactory.layerNoDeps),
    Effect.provide(Layer.succeed(Daemon, daemon.service)),
    Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
    Effect.provide(BunSocket.layerWebSocketConstructor),
    Effect.provide(Layer.succeed(Log, log.service)),
    Effect.scoped
  )
  try {
    await Effect.runPromise(prog)
  } finally {
    daemon.close()
  }
}

const count = (daemon: FakeDaemon, method: string): number => daemon.methods().filter((m) => m === method).length

/**
 * The Bridge's `[mcp]` log lines. They are diagnostics asserted next to the
 * external proof — the runtime the fake daemon last accepted, and its call
 * sequence — never as its substitute: the reason a runtime was replaced is
 * only observable through this line, the outcome never is.
 */
const mcpWarnings = (warnings: readonly string[]): string[] => warnings.filter((line) => line.includes("[mcp]"))

/** Waits in real time until the fake daemon has seen something: for a Turn that runs on the test clock. */
const settled = (seen: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempts = 0; !seen(); attempts++) {
      if (attempts === 1_000) return yield* Effect.die("the fake daemon never saw it")
      yield* Effect.sleep("5 millis")
    }
  })

/**
 * Runs one Turn on the test clock, as far as the Bridge's patience with a
 * runtime another party is making goes: the Turn is forked, the Bridge reads
 * the lifecycle and starts polling, and the clock jumps past the whole settle
 * budget. What the Turn does next is what the code under test does when the
 * other party's creation never settles.
 */
const turnOutTheSettleBudget = (
  prompt: Effect.Effect<unknown, unknown>,
  daemon: FakeDaemon,
  clock: TestClock.TestClock
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads = count(daemon, "getSessionLifecycle")
      const turn = yield* prompt.pipe(Effect.provideService(Clock.Clock, clock), Effect.forkScoped)
      yield* settled(() => count(daemon, "getSessionLifecycle") > reads)
      // The answer needs to land before the clock moves: with it still in flight
      // the jump would time the read out instead.
      yield* Effect.sleep("50 millis")
      yield* clock.adjust("21 seconds")
      yield* Fiber.join(turn)
    })
  )

describe("ServeSession keeps the Client's MCP servers in the session's runtime (issue #26)", () => {
  test("a Turn after a daemon restart runs on the runtime the Bridge resumed with them", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.restart()
        yield* session.sendPrompt("after the restart")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        // Nothing was lost, so nothing is warned about.
        expect(mcpWarnings(warnings)).toEqual([])
      })
    )
  })

  test("the resume that creates the runtime names the session and the workspace flat, like createSession", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.restart()
        yield* session.sendPrompt("after the restart")
        // The daemon's handler reads `params.workspacePath` and
        // `params.workspaceIdentity` itself; a nested `workspace` object
        // fails the call before the daemon logs it, which is how the incident
        // session lost its servers (silently, because the call is tolerated).
        const resume = daemon.calls.find((call) => call.method === "resumeSession")
        expect(resume?.channel).toBe("zcode-session")
        expect(resume?.arg).toEqual({
          sessionId: DAEMON_SESSION,
          workspacePath: CWD,
          workspaceIdentity: CWD,
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
      })
    )
  })

  test("a daemon that does not report the lifecycle still gets the resume on re-attach", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.behaviour.noLifecycle = true
        daemon.restart()
        yield* session.sendPrompt("after the restart")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        expect(count(daemon, "resumeSession")).toBe(1)
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
      })
    )
  })

  test("a refused resume on re-attach does not leave the Turn on a runtime without them", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.restart()
        daemon.behaviour.resumeRefusals = 1
        yield* session.sendPrompt("after the restart")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a runtime the daemon recreated first is replaced before the Turn", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.restart()
        // Something else resumed the session before the Bridge re-attached.
        daemon.coldActivate()
        yield* session.sendPrompt("after the restart")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        // What the Bridge recorded says why: the daemon process changed.
        expect(mcpWarnings(warnings).some((line) => line.includes("the daemon restarted"))).toBe(true)
      })
    )
  })

  test("a runtime the daemon unloaded is resumed with them before the Turn", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        yield* session.sendPrompt("first")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))

        daemon.unload()
        yield* session.sendPrompt("after the idle unload")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a runtime replaced while the Bridge is attached is replaced again, with them", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        yield* session.sendPrompt("after the plugin reload")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        // The old subscription was registered against the old runtime.
        expect(count(daemon, "subscribeConversationV4")).toBe(2)
        expect(count(daemon, "unsubscribeConversationV4")).toBe(1)
        // Same daemon process, another generation: the daemon's own doing.
        expect(mcpWarnings(warnings).some((line) => line.includes("the daemon replaced the runtime"))).toBe(true)
      })
    )
  })

  test("the replacement waits for a runtime another party is still creating", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        daemon.behaviour.startingAnswers = 2
        yield* session.sendPrompt("while another party resumes the session")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a runtime another party never finishes making is not taken for one that holds them", async () => {
    await run(({ session, daemon, warnings, clock }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        // Another party resumes the session, and its runtime is still being
        // made when the Bridge runs out of patience: the resume lands on it.
        daemon.coldActivate()
        daemon.behaviour.stuckStarting = true
        yield* turnOutTheSettleBudget(session.sendPrompt("while that runtime never settles"), daemon, clock)
        // Nothing could be done for this Turn — but the Bridge does not
        // record that runtime as holding the servers, so the loss is said
        // out loud and lasts one Turn instead of the rest of the thread.
        expect(daemon.turnMcp()).toEqual([])
        expect(mcpWarnings(warnings).some((line) => line.includes("did not replace the runtime"))).toBe(true)

        daemon.behaviour.stuckStarting = false
        yield* session.sendPrompt("the next Turn")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        expect(count(daemon, "stopSessionRuntime")).toBe(1)
      })
    )
  })

  test("two Turns arriving together replace an untrusted runtime once", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        // Both read the lifecycle before either acts on it — the worst case
        // for a steer landing with its prompt.
        daemon.behaviour.lifecycleHoldMs = 30
        yield* Effect.scoped(
          Effect.gen(function* () {
            const prompt = yield* session.sendPrompt("the prompt").pipe(Effect.forkScoped)
            const steer = yield* session.sendPrompt("the steer").pipe(Effect.forkScoped)
            yield* Fiber.join(prompt)
            yield* Fiber.join(steer)
          })
        )
        // A second replacement would have stopped the runtime the first Turn
        // had just gone out on.
        expect(count(daemon, "stopSessionRuntime")).toBe(1)
        expect(count(daemon, "resumeSession")).toBe(1)
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a runtime that already holds them is left alone", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        yield* session.sendPrompt("first")
        yield* session.sendPrompt("second")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
        expect(count(daemon, "resumeSession")).toBe(0)
        expect(count(daemon, "subscribeConversationV4")).toBe(1)
      })
    )
  })

  test("a channel that drops without a daemon restart does not replace the live runtime", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        yield* session.sendPrompt("first")
        // Same pid and start time: the daemon kept the runtime, only the
        // Bridge's channel to it went away.
        daemon.dropChannel()
        yield* session.sendPrompt("after the channel dropped")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
      })
    )
  })

  test("a refused stop is logged, the Turn still goes out, and the next Turn tries again", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        daemon.behaviour.stopRefusals = 1
        yield* session.sendPrompt("the daemon refuses to stop the runtime")
        expect(daemon.turnMcp()).toEqual([])
        expect(warnings.some((line) => line.includes("[mcp]") && line.includes("stop refused"))).toBe(true)

        yield* session.sendPrompt("the next Turn")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a daemon that does not report the lifecycle has its runtimes left alone", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.behaviour.noLifecycle = true
        daemon.coldActivate()
        yield* session.sendPrompt("on an older daemon")
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
        expect(daemon.turnMcp()).toEqual([])
      })
    )
  })

  test("a lifecycle the daemon refuses to report leaves the runtime alone, and the Turn still goes out", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        daemon.behaviour.lifecycleRefusals = 100
        yield* session.sendPrompt("while the daemon will not say which runtime it has")
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
        expect(daemon.turnMcp()).toEqual([])

        daemon.behaviour.lifecycleRefusals = 0
        yield* session.sendPrompt("once it answers again")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a daemon without lifecycle reporting survives a refused resume on re-attach", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.behaviour.noLifecycle = true
        daemon.restart()
        daemon.behaviour.resumeRefusals = 1
        // Nothing to tell a runtime by on that daemon: the Turn runs on the
        // one the subscribe created, without the servers.
        yield* session.sendPrompt("after the restart")
        expect(daemon.turnMcp()).toEqual([])
        // No later Turn can notice on that daemon, so the refusal is the last
        // word on it — the silence that hid the incident, spoken this time.
        expect(mcpWarnings(warnings).some((line) => line.includes("resume refused"))).toBe(true)
      })
    )
  })

  test("an empty server list from the Client changes nothing", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        const before = daemon.calls.length
        yield* session.setMcpServers([])
        expect(daemon.calls.length).toBe(before)

        daemon.restart()
        yield* session.sendPrompt("after the restart")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a new server list replaces the old one with the next Turn", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        // The Client re-attached with another definition of its server.
        yield* session.setMcpServers(t3Code(4001))
        yield* session.sendPrompt("with the new list")
        expect(daemon.turnMcp()).toEqual(inRuntime(4001))
        yield* session.sendPrompt("and the Turn after it")
        expect(daemon.turnMcp()).toEqual(inRuntime(4001))
        expect(count(daemon, "stopSessionRuntime")).toBe(1)
        // The runtime did not come back changed: the Client's list did.
        expect(mcpWarnings(warnings).some((line) => line.includes("was not made with"))).toBe(true)
        expect(mcpWarnings(warnings).some((line) => line.includes("came back"))).toBe(false)
      })
    )
  })

  test("the same server list again changes nothing", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        const before = daemon.calls.length
        yield* session.setMcpServers(t3Code(4000))
        expect(daemon.calls.length).toBe(before)
        yield* session.sendPrompt("first")
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
      })
    )
  })

  test("restartRuntime leaves behind a runtime that holds them, and the next Turn knows", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        yield* session.restartRuntime
        yield* session.sendPrompt("after the restart this Bridge asked for")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
        expect(count(daemon, "stopSessionRuntime")).toBe(1)
      })
    )
  })

  test("without Client MCP servers a Turn sends nothing on their behalf", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, undefined)
        daemon.unload()
        yield* Effect.exit(session.sendPrompt("no servers to put anywhere"))
        expect(count(daemon, "getSessionLifecycle")).toBe(0)
        expect(count(daemon, "resumeSession")).toBe(0)
        expect(count(daemon, "stopSessionRuntime")).toBe(0)
      })
    )
  })

  test("a re-attach with no Client MCP servers says so", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, undefined)
        daemon.dropChannel()
        yield* session.sendPrompt("after the reconnect")
        expect(mcpWarnings(warnings).some((line) => line.includes("no Client MCP servers recorded"))).toBe(true)
      })
    )
  })

  test("a resume that fails after the runtime was stopped restores it without them", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        daemon.behaviour.resumeRefusals = 1
        // The Bridge stops the runtime it cannot trust, then its resume with
        // the servers is refused. A bare resume has to bring the session back
        // or the Turn dies at dispatch.
        yield* session.sendPrompt("the resume is refused")
        expect(daemon.turnMcp()).toEqual([])
        expect(mcpWarnings(warnings).some((line) => line.includes("restoring its runtime without them"))).toBe(true)

        yield* session.sendPrompt("the next Turn")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("a Turn whose resume is refused twice fails, and the next Turn brings the servers back", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        daemon.behaviour.resumeRefusals = 2
        // Neither the resume with the servers nor the bare one that would
        // restore the session gets through, so this Turn has no runtime to
        // dispatch onto — and it says so once.
        const failed = yield* Effect.exit(session.sendPrompt("both resumes are refused"))
        expect(failed._tag).toBe("Failure")
        expect(mcpWarnings(warnings).some((line) => line.includes("could not restore the runtime"))).toBe(true)

        yield* session.sendPrompt("once the daemon answers")
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })

  test("restartRuntime does not record a runtime its resume did not mint", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        // The stop reports success but the runtime stays live, so the resume
        // lands on it and no generation is minted: recording it would claim
        // the servers are in a runtime the resume never made.
        daemon.behaviour.stopIgnored = true
        yield* session.restartRuntime
        expect(mcpWarnings(warnings).some((line) => line.includes("did not mint a new generation"))).toBe(true)
      })
    )
  })

  test("a refused subscribe after a replacement does not leave the session unable to subscribe", async () => {
    await run(({ session, daemon, warnings }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        daemon.behaviour.subscribeRefusals = 1
        yield* session.sendPrompt("the resubscribe is refused")
        expect(warnings.some((line) => line.includes("[mcp]"))).toBe(true)

        // The next Turn replaces the runtime again, and its resubscribe has to
        // reach the daemon: a stuck "subscribed" flag would skip it and the
        // Turn would wait for frames that never come.
        yield* session.sendPrompt("the next Turn")
        expect(count(daemon, "subscribeConversationV4")).toBe(3)
      })
    )
  })

  test("a list that changes while its runtime is being made is not recorded as holding it", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        yield* session.createSession(undefined, t3Code(4000))
        daemon.coldActivate()
        // Long enough that the list changes while the Turn's lifecycle read is
        // in flight — the window where an assertion would name the wrong list.
        daemon.behaviour.lifecycleHoldMs = 200
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* Effect.forkScoped(session.sendPrompt("with the old list"))
            yield* Effect.sleep("25 millis")
            yield* session.setMcpServers(t3Code(4001))
            yield* Fiber.join(turn)
          })
        )
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))

        // The changed list was not recorded as already in the runtime, so the
        // next Turn applies it instead of skipping the replacement.
        yield* session.sendPrompt("with the new list")
        expect(daemon.turnMcp()).toEqual(inRuntime(4001))
      })
    )
  })

  test("a status that cannot identify its daemon is trusted only on the same connection", async () => {
    await run(({ session, daemon }) =>
      Effect.gen(function* () {
        daemon.behaviour.anonymousStatus = true
        yield* session.createSession(undefined, t3Code(4000))
        yield* session.sendPrompt("first")
        yield* session.sendPrompt("second")
        // No pid or start time to key on, but the same connection: the runtime
        // is left alone rather than replaced on every Turn.
        expect(count(daemon, "stopSessionRuntime")).toBe(0)

        // A reconnect is the only way a restart reaches the Bridge. Without an
        // identity to compare, the runtime is not trusted across it.
        daemon.dropChannel()
        yield* session.sendPrompt("after the reconnect")
        expect(count(daemon, "stopSessionRuntime")).toBe(1)
        expect(daemon.turnMcp()).toEqual(inRuntime(4000))
      })
    )
  })
})

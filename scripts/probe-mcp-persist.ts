#!/usr/bin/env bun
/**
 * Live probe for issue #26 — does a session keep the Client's MCP servers
 * when the daemon recreates its runtime?
 *
 * Drives the REAL Bridge over ACP stdio (the way scripts/smoke.mjs does) with
 * one scratch session that carries a private stdio MCP server
 * (scripts/probe-mcp-server.ts), and reads the daemon's own log as the
 * oracle: `mcp.server.connected` naming that server means the runtime holds
 * it, so the model can see its tools.
 *
 *   1. session/new with the MCP server, then one warm-up Turn (a session
 *      without a message is not persisted, and stopping an unpersisted
 *      runtime discards it)                     → the server connects
 *   2. the daemon unloads the runtime. Side channel, THIS scratch session
 *      only: `session/lifecycle/stop` is what the resident pool's
 *      idle_timeout deactivation does to an idle session (10 min by default,
 *      DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS). No daemon restart, so the
 *      probe never disturbs other sessions.
 *   3. session/prompt through the Bridge      → does the server connect AGAIN?
 *   4. one more Turn                          → nothing happens: a runtime
 *      that holds the servers is left alone (not replaced on every Turn)
 *   5. the incident itself: the runtime is unloaded again and ANOTHER PARTY
 *      (this probe, on its own channel) cold-subscribes the session, which
 *      recreates the runtime without the servers. A resume on that live
 *      runtime applies nothing — a daemon fact, reported not asserted; should
 *      that stop holding, the Bridge's stop-before-resume is no longer
 *      needed. Then a Turn through the Bridge → the server connects again.
 *
 * Usage: bun scripts/probe-mcp-persist.ts [--bin PATH] [--cwd PATH] [--verbose]
 *   `--bin` defaults to dist/zcode-serve-acp (falling back to src/bin.ts).
 *   `--verbose` forwards the Bridge's debug log (ZCODE_SERVE_ACP_DEBUG=1).
 *
 * Needs a ready local daemon. Costs three short model turns. Leaves one
 * scratch session in the daemon's store, with its runtime stopped.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import path from "node:path"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Cause, Clock, DateTime, Effect, Exit, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChannelClosed, RpcError, RpcTimeout, renderError } from "../src/errors.ts"
import { ChannelClient } from "../src/serve/channel.ts"
import { Daemon, dataRoot } from "../src/serve/daemon.ts"
import { Log } from "../src/log.ts"

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const argOf = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const binArg = argOf("--bin", "")
const binary = path.resolve(binArg !== "" ? binArg : path.join(repo, "dist", "zcode-serve-acp"))
if (binArg !== "" && !existsSync(binary)) {
  console.error(`[probe] --bin not found: ${binary}`)
  process.exit(2)
}
const useBinary = existsSync(binary)
const cwd = argOf("--cwd", repo)
const verbose = process.argv.includes("--verbose")

const MCP_NAME = `probe-mcp-${crypto.randomUUID().slice(0, 8)}`
const MCP_SERVER = path.join(repo, "scripts", "probe-mcp-server.ts")
const CONNECT_TIMEOUT_MS = 60_000
const POLL_MS = 250

const NOTE = "zcode_protocol."
const LIFECYCLE = `${NOTE}session.lifecycle_changed`
const RECORD = `${NOTE}create_record.mcp_config`

// ---- daemon log (the oracle) ----

interface LogEntry {
  readonly at: number
  readonly event: string
  readonly sessionId?: string
  readonly context?: Record<string, unknown>
}

const now = new Date()
const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
const logFile = path.join(dataRoot(), ".zcode", "cli", "log", `zcode-${localDate}.jsonl`)
if (!existsSync(logFile)) {
  console.error(`[probe] daemon log not found: ${logFile}`)
  process.exit(2)
}
// Only lines appended after the probe started are read: one open fd, a byte
// offset, and a partial-line carry between polls.
const logFd = openSync(logFile, "r")
let logOffset = statSync(logFile).size
let logCarry = ""

const readNewEntries = (): LogEntry[] => {
  const size = statSync(logFile).size
  if (size <= logOffset) return []
  const buffer = Buffer.alloc(size - logOffset)
  readSync(logFd, buffer, 0, buffer.length, logOffset)
  logOffset = size
  const lines = (logCarry + buffer.toString("utf8")).split("\n")
  logCarry = lines.pop() ?? ""
  const entries: LogEntry[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: string
        event?: string
        sessionId?: string
        context?: Record<string, unknown>
      }
      if (parsed.event === undefined) continue
      // An entry whose stamp does not parse carries no time, so it is never "after" a mark.
      const stamped = DateTime.make(parsed.timestamp ?? "")
      entries.push({
        at: Option.isSome(stamped) ? DateTime.toEpochMillis(stamped.value) : Number.NaN,
        event: parsed.event,
        sessionId: parsed.sessionId,
        context: parsed.context
      })
    } catch {
      // a torn or non-JSON line carries no signal
    }
  }
  return entries
}

/** Every log line seen so far, oldest first. */
const seen: LogEntry[] = []
const poll = (): void => {
  seen.push(...readNewEntries())
}

const isConnected = (entry: LogEntry, sessionId: string): boolean =>
  entry.event === "mcp.server.connected" &&
  entry.context?.["mcpServerName"] === MCP_NAME &&
  entry.sessionId === sessionId

const isState = (entry: LogEntry, sessionId: string, state: string, after: number): boolean =>
  entry.event === LIFECYCLE && entry.sessionId === sessionId && entry.context?.["state"] === state && entry.at > after

/** Polls the daemon log until `probe` finds something; fails once `timeoutMs` has passed. */
const waitFor = <A>(
  label: string,
  probe: () => A | undefined,
  timeoutMs = CONNECT_TIMEOUT_MS
): Effect.Effect<A, Error> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    for (;;) {
      poll()
      const found = probe()
      if (found !== undefined) return found
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.fail(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`))
      }
      yield* Effect.sleep(POLL_MS)
    }
  })

// ---- the Bridge, over ACP stdio ----

interface AcpClient {
  readonly request: (method: string, params: unknown) => Promise<Record<string, unknown>>
  readonly close: () => void
}

const connectBridge = (): AcpClient => {
  const cmd = useBinary ? binary : "bun"
  const args = useBinary ? [] : [path.join(repo, "src", "bin.ts")]
  console.error(`[probe] bridge: ${[cmd, ...args].join(" ")}`)
  const child: ChildProcess = spawn(cmd, args, {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZCODE_SERVE_ACP_DEBUG: verbose ? "1" : "0" }
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    if (verbose) process.stderr.write(`[bridge] ${chunk}`)
  })

  let nextId = 1
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() === "") continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      // A server→client request (permission, elicitation). Nothing here needs
      // a tool, so anything that still arrives is declined.
      if (message["method"] !== undefined && message["id"] !== undefined) {
        const decline = JSON.stringify({
          jsonrpc: "2.0",
          id: message["id"],
          error: { code: -32601, message: "probe declines" }
        })
        child.stdin?.write(`${decline}\n`)
        continue
      }
      const responder = pending.get(Number(message["id"]))
      if (responder !== undefined) {
        pending.delete(Number(message["id"]))
        responder(message)
      }
    }
  })

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, (message) => {
          if (message["error"] !== undefined) reject(new Error(`${method}: ${JSON.stringify(message["error"])}`))
          else resolve((message["result"] ?? {}) as Record<string, unknown>)
        })
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`))
        }, 240_000)
      }),
    close: () => child.kill()
  }
}

// ---- the scenario ----

/** Calls the probe makes on the daemon itself, next to the Bridge. */
interface Side {
  /** Aim the side calls at one daemon session (workspace fields as the Bridge sends them). */
  readonly bind: (daemonSessionId: string) => void
  readonly isBound: () => boolean
  readonly stop: Effect.Effect<unknown, RpcError | RpcTimeout | ChannelClosed>
  readonly subscribe: Effect.Effect<unknown, RpcError | RpcTimeout | ChannelClosed>
  readonly resume: Effect.Effect<unknown, RpcError | RpcTimeout | ChannelClosed>
  readonly lifecycle: Effect.Effect<unknown, RpcError | RpcTimeout | ChannelClosed>
}

interface Verdict {
  readonly ok: boolean
  readonly lines: string[]
}

/** What the probe printed: one line per check, and PASS only if none failed. */
const makeReport = () => {
  const lines: string[] = []
  let failures = 0
  const check = (ok: boolean, line: string): void => {
    if (!ok) failures += 1
    lines.push(`${ok ? "ok  " : "FAIL"} ${line}`)
    console.error(`[probe] ${ok ? "ok  " : "FAIL"} ${line}`)
  }
  const note = (line: string): void => {
    lines.push(`     ${line}`)
    console.error(`[probe]      ${line}`)
  }
  return {
    check,
    note,
    verdict: (): Verdict => ({ ok: failures === 0, lines })
  }
}

const lastStateAt = (sessionId: string): number =>
  seen.filter((entry) => entry.event === LIFECYCLE && entry.sessionId === sessionId).at(-1)?.at ?? 0

/** The lifecycle `generation` of a raw `getSessionLifecycle` answer; NaN when it does not say. */
const generationOf = (lifecycle: unknown): number =>
  (lifecycle as { generation?: unknown } | null)?.generation as number

const seconds = (entry: LogEntry, after: number): string => `t+${((entry.at - after) / 1000).toFixed(1)}s`

const scenario = (side: Side, report: ReturnType<typeof makeReport>): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const bridge = connectBridge()
    yield* Effect.gen(function* () {
      const { check, note } = report
      const call = (method: string, params: unknown) => Effect.promise(() => bridge.request(method, params))
      /** The first log entry `probe` finds; undefined when none arrives in time. */
      const settled = <A>(label: string, probe: () => A | undefined): Effect.Effect<A | undefined> =>
        waitFor(label, probe).pipe(Effect.orElseSucceed(() => undefined))
      /** One short Turn through the Bridge. */
      const turn = (acpSessionId: unknown, text: string) =>
        call("session/prompt", { sessionId: acpSessionId, prompt: [{ type: "text", text }] })
      const connectedAfter = (sessionId: string, after: number) => () =>
        seen.find((entry) => isConnected(entry, sessionId) && entry.at > after)
      const stateAfter = (sessionId: string, state: string, after: number) => () =>
        seen.find((entry) => isState(entry, sessionId, state, after))
      const lifecycleNow = (): Effect.Effect<string, RpcError | RpcTimeout | ChannelClosed> =>
        Effect.map(side.lifecycle, JSON.stringify)

      yield* call("initialize", { protocolVersion: 2, clientCapabilities: {} })
      const created = yield* call("session/new", {
        cwd,
        mcpServers: [{ type: "stdio", name: MCP_NAME, command: process.execPath, args: [MCP_SERVER] }]
      })
      note(`session/new → ${String(created["sessionId"])}`)

      // 1. The server connects when the runtime is first created.
      const first = yield* settled("the first MCP connect", () =>
        seen.find((entry) => isConnected(entry, entry.sessionId ?? ""))
      )
      if (first === undefined) return yield* Effect.fail(new Error("the daemon never connected the MCP server"))
      const daemonSessionId = first.sessionId ?? ""
      side.bind(daemonSessionId)
      note(`daemon session ${daemonSessionId}: ${MCP_NAME} connected`)
      // A session with no message yet is not persisted, and stopping an
      // unpersisted runtime discards the session outright (live, runtime 4.0.0:
      // `Session not found` afterwards). The resident pool only deactivates
      // persisted sessions, so make this one real first.
      yield* turn(created["sessionId"], "Reply with exactly: WARM_UP_OK")
      const createdGeneration = generationOf(yield* side.lifecycle)
      note(`warm-up turn done; lifecycle ${yield* lifecycleNow()}`)

      // 2. The daemon unloads the runtime — the Bridge's channel stays up.
      yield* side.stop
      yield* settled("lifecycle unloaded", stateAfter(daemonSessionId, "unloaded", first.at))
      note(`runtime unloaded; lifecycle now ${yield* lifecycleNow()}`)

      // 3. The next Turn must bring the server back.
      const unloadedAt = yield* Clock.currentTimeMillis
      note(`prompt → ${JSON.stringify(yield* turn(created["sessionId"], "Reply with exactly: PROBE_OK"))}`)
      const again = yield* settled("the MCP server to reconnect", connectedAfter(daemonSessionId, unloadedAt))
      check(
        again !== undefined,
        `after the daemon unloaded the runtime, the next Turn brings the Client's MCP server back (${
          again ? seconds(again, unloadedAt) : "it never reconnected — the toolset is lost"
        })`
      )
      for (const entry of seen.filter(
        (entry) => entry.event === RECORD && entry.sessionId === daemonSessionId && entry.at > unloadedAt
      )) {
        note(
          `runtime recreated with paramMcpServerCount=${String(entry.context?.["paramMcpServerCount"])} runtimeHasMcpConfig=${String(entry.context?.["runtimeHasMcpConfig"])}`
        )
      }
      const resumedGeneration = generationOf(yield* side.lifecycle)
      note(`lifecycle after that Turn ${yield* lifecycleNow()}`)
      check(
        resumedGeneration > createdGeneration,
        `every creation mints a lifecycle generation (created → ${createdGeneration}, after the resume → ${resumedGeneration}) — it is what the Bridge tells one runtime from another by`
      )

      // 4. A runtime that holds them is left alone: no replacement on every Turn.
      const settledAt = yield* Clock.currentTimeMillis
      yield* turn(created["sessionId"], "Reply with exactly: AGAIN_OK")
      yield* Effect.sleep("3 seconds")
      poll()
      const churn = seen.filter(
        (entry) =>
          entry.sessionId === daemonSessionId &&
          entry.at > settledAt &&
          (isConnected(entry, daemonSessionId) || entry.event === LIFECYCLE || entry.event === RECORD)
      )
      check(
        churn.length === 0,
        `a Turn on a runtime that holds them leaves it alone (${
          churn.length === 0
            ? "no reconnect, no runtime change"
            : `the runtime was replaced again: ${[...new Set(churn.map((entry) => entry.event))].join(", ")}`
        })`
      )

      // 5. The incident itself. Another party resumes the session first — a
      // cold subscribe is what recreates the runtime, without the servers —
      // and then a Turn comes in through the Bridge.
      const beforeIncident = lastStateAt(daemonSessionId)
      yield* side.stop
      yield* settled("lifecycle unloaded before the incident", stateAfter(daemonSessionId, "unloaded", beforeIncident))
      yield* side.subscribe
      yield* settled("lifecycle ready after the cold subscribe", stateAfter(daemonSessionId, "ready", beforeIncident))
      note(`another party resumed the session; lifecycle now ${yield* lifecycleNow()}`)
      const incidentAt = yield* Clock.currentTimeMillis
      yield* turn(created["sessionId"], "Reply with exactly: INCIDENT_OK")
      const rescued = yield* settled("the MCP server to reconnect", connectedAfter(daemonSessionId, incidentAt))
      check(
        rescued !== undefined,
        `the incident path — another party resumed the session without the servers, then a Turn came in — ends with the Client's MCP server back (${
          rescued ? seconds(rescued, incidentAt) : "it stayed without them — the toolset is lost"
        })`
      )
      for (const entry of seen.filter(
        (entry) => entry.event === LIFECYCLE && entry.sessionId === daemonSessionId && entry.at > incidentAt
      )) {
        note(`lifecycle ${String(entry.context?.["state"])} (generation ${String(entry.context?.["generation"])})`)
      }

      // 6. Daemon fact, reported not asserted: a resume with mcpServers on a
      // LIVE runtime is a no-op. Should that stop holding, the Bridge's
      // stop-before-resume is no longer needed.
      const beforeFact = lastStateAt(daemonSessionId)
      yield* side.stop
      yield* settled("lifecycle unloaded again", stateAfter(daemonSessionId, "unloaded", beforeFact))
      yield* side.subscribe
      yield* settled("lifecycle ready after the cold subscribe", stateAfter(daemonSessionId, "ready", beforeFact))
      const factAt = yield* Clock.currentTimeMillis
      yield* side.resume
      yield* Effect.sleep("6 seconds")
      poll()
      const applied = seen.some((entry) => isConnected(entry, daemonSessionId) && entry.at >= factAt)
      note(
        applied
          ? "daemon fact CHANGED: session/resume applied mcpServers to a live runtime"
          : "daemon fact holds: session/resume with mcpServers on a live runtime applied nothing — a resume alone cannot restore the toolset"
      )
    }).pipe(Effect.ensuring(Effect.sync(() => bridge.close())))
  })

const probe = (side: Side): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    const report = makeReport()
    const cleanup = Effect.gen(function* () {
      // Leave the scratch session's runtime stopped so its MCP child exits.
      if (side.isBound()) {
        yield* Effect.exit(side.stop).pipe(
          Effect.map((exit) => {
            if (Exit.isFailure(exit))
              console.error(`[probe] final stop failed: ${renderError(Cause.squash(exit.cause))}`)
          })
        )
      }
      closeSync(logFd)
    })
    // exit, not result: a defect in the scenario (a rejected ACP request is
    // one) must land in the report rather than kill the probe.
    const outcome = yield* Effect.exit(scenario(side, report).pipe(Effect.ensuring(cleanup)))
    if (Exit.isFailure(outcome)) {
      report.check(false, `probe aborted: ${renderError(Cause.squash(outcome.cause))}`)
    }
    return report.verdict()
  })

const program = Effect.gen(function* () {
  const daemon = yield* Daemon
  const log = yield* Log
  const connection = yield* daemon.connect
  const capability = yield* daemon.getCapability(connection)
  const url =
    `ws://${connection.status.host}:${connection.status.port}${connection.wsPath}` +
    (connection.token ? `?token=${encodeURIComponent(connection.token)}` : "")
  const channel = yield* ChannelClient.connect(
    url,
    { "x-zcode-rpc-host-capability": capability },
    { onRequest: () => Effect.succeed(undefined), onClose: () => Effect.void },
    log
  )
  console.error(
    `[probe] daemon ${connection.status.version ?? "?"} at ${connection.status.host}:${connection.status.port}`
  )
  console.error(`[probe] ${MCP_NAME} via ${MCP_SERVER}`)

  let workspace: Record<string, unknown> | undefined
  // server-core.js 4.0.0 host handlers: getSessionLifecycle / stopSessionRuntime /
  // subscribeConversationV4 on channel `zcode-agent`, resumeSession on
  // `zcode-session` — flat workspace fields, as the Bridge sends them.
  const side: Side = {
    bind: (daemonSessionId) => {
      workspace = { sessionId: daemonSessionId, workspacePath: cwd, workspaceIdentity: cwd }
    },
    isBound: () => workspace !== undefined,
    stop: Effect.suspend(() => channel.call("zcode-agent", "stopSessionRuntime", workspace, 150_000)),
    subscribe: Effect.suspend(() =>
      channel.call("zcode-agent", "subscribeConversationV4", { ...workspace, visibility: "background" }, 30_000)
    ),
    resume: Effect.suspend(() =>
      channel.call(
        "zcode-session",
        "resumeSession",
        {
          ...workspace,
          mcpServers: [
            {
              name: MCP_NAME,
              command: process.execPath,
              args: [MCP_SERVER],
              env: [],
              isolation: "session",
              alwaysLoad: true
            }
          ]
        },
        150_000
      )
    ),
    lifecycle: Effect.suspend(() => channel.call("zcode-agent", "getSessionLifecycle", workspace, 15_000))
  }
  return yield* probe(side)
}).pipe(
  Effect.scoped,
  Effect.provide(
    Daemon.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunSocket.layerWebSocketConstructor, Log.layerQuiet)
      )
    )
  )
)

const exitCode = await Effect.runPromiseExit(program).then(
  (exit) => {
    if (exit._tag === "Failure") {
      console.error("[probe] failed:", exit.cause)
      return 1
    }
    console.log(exit.value.lines.join("\n"))
    console.error(`[probe] ${exit.value.ok ? "PASS" : "FAIL"}`)
    return exit.value.ok ? 0 : 1
  },
  (cause) => {
    console.error("[probe] failed:", cause)
    return 1
  }
)
process.exit(exitCode)

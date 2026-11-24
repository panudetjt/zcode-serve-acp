/**
 * Inbound transport: stdin must keep flowing while a Turn is in flight.
 *
 * A `session/prompt` stays open for the whole Turn, so a sequential read loop
 * queued `session/cancel` and the Client's answer to `session/request_permission`
 * behind it — Stop did nothing and the ask timed out after 600s. These tests
 * drive the real `runInboundLoop` over a queue-backed stdin and fail if either
 * message has to wait for the Turn to end.
 */
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Queue, Stream } from "effect"
import { AcpServer } from "../src/acp/server.ts"
import { makeTransport, runInboundLoop, type Transport } from "../src/acp/transport.ts"
import { Log } from "../src/log.ts"
import type { AvailableModel, ServeSession, ServeSessionFactory } from "../src/serve/session.ts"

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

const encoder = new TextEncoder()
const encode = (message: unknown): Uint8Array => encoder.encode(`${JSON.stringify(message)}\n`)

/** Poll a predicate with a hard deadline so a blocked loop fails fast instead of hanging the suite. */
const waitFor = (predicate: () => boolean, label: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
  })

interface Harness {
  readonly calls: string[]
  readonly frames: Array<Record<string, unknown>>
  readonly warnings: string[]
  readonly transport: Transport
  readonly send: (message: unknown) => Effect.Effect<boolean>
  /** Raw bytes, for lines that are not JSON at all. */
  readonly sendRaw: (text: string) => Effect.Effect<boolean>
  readonly close: Effect.Effect<boolean>
}

const makeHarness = (options?: { timeoutMs?: number }): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const calls: string[] = []
    const frames: Array<Record<string, unknown>> = []
    const warnings: string[] = []
    const log: Log["Service"] = {
      debug: () => Effect.void,
      warn: (...parts) =>
        Effect.sync(() => {
          warnings.push(parts.map(String).join(" "))
        }),
      debugSync: () => {}
    }
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()

    const transport = makeTransport({
      write: (raw) =>
        Effect.sync(() => {
          frames.push(JSON.parse(raw) as Record<string, unknown>)
        }),
      log,
      timeoutMs: options?.timeoutMs ?? 2_000
    })

    const session = {
      createSession: () =>
        Effect.succeed({
          models: sampleModels,
          currentModel: "zai-provider/GLM-5.3",
          skills: [],
          currentMode: "default"
        }),
      setMcpServers: () => Effect.void,
      sendPrompt: () =>
        Effect.sync(() => {
          calls.push("sendPrompt")
        }).pipe(Effect.as({ inputId: "inp-1" })),
      setMode: () => Effect.void,
      sendCommand: (name: string) =>
        Effect.sync(() => {
          calls.push(`sendCommand:${name}`)
        }),
      dispose: Effect.void
    } as unknown as ServeSession

    const server = AcpServer.make({
      sessions: { create: () => Effect.succeed(session) } as unknown as ServeSessionFactory["Service"],
      log,
      emitNotification: (method, params) =>
        Effect.sync(() => {
          frames.push({ method, params })
        }),
      clientRequest: transport.clientRequest,
      fallbackModels: Effect.succeed(sampleModels),
      // Long enough that the initial-response guard never fires mid-test.
      turnTimeoutMs: 30_000
    })

    yield* Effect.forkDetach(runInboundLoop({ stdin: Stream.fromQueue(stdin), transport, log, handle: server.handle }))

    return {
      calls,
      frames,
      warnings,
      transport,
      send: (message: unknown) => Queue.offer(stdin, encode(message)),
      sendRaw: (text: string) => Queue.offer(stdin, encoder.encode(text)),
      close: Queue.end(stdin)
    }
  })

const openSession = (harness: Harness): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* harness.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { sessionId: "s1", cwd: "/tmp" } })
    yield* waitFor(() => harness.frames.some((frame) => frame.id === 1), "session/new response")
  })

const startTurn = (harness: Harness): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] }
    })
    yield* waitFor(() => harness.calls.includes("sendPrompt"), "the Turn to start")
  })

describe("inbound transport concurrency", () => {
  test("session/cancel reaches the session while a Turn is in flight", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        yield* openSession(harness)
        yield* startTurn(harness)

        // The Turn has not ended (nothing completed its Deferred): only a
        // concurrent read loop can deliver this line now.
        yield* harness.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } })
        yield* waitFor(() => harness.calls.includes("sendCommand:stop"), "session/cancel to reach the session")
        yield* waitFor(() => harness.frames.some((frame) => frame.id === 2), "the prompt response")

        const response = harness.frames.find((frame) => frame.id === 2) as { result: { stopReason: string } }
        expect(response.result.stopReason).toBe("cancelled")
        yield* harness.close
      })
    )
  })

  test("a permission answer reaches the waiting clientRequest while a Turn is in flight", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        yield* openSession(harness)
        yield* startTurn(harness)

        const answer: { value?: unknown; failure?: string } = {}
        yield* Effect.forkDetach(
          harness.transport
            .clientRequest("session/request_permission", { sessionId: "s1", options: [{ optionId: "allow" }] })
            .pipe(
              Effect.tap((value) => Effect.sync(() => void (answer.value = value))),
              Effect.catchCause((cause) => Effect.sync(() => void (answer.failure = String(cause))))
            )
        )
        yield* waitFor(
          () => harness.frames.some((frame) => frame.id === 900_000),
          "the permission ask to reach the Client"
        )

        yield* harness.send({
          jsonrpc: "2.0",
          id: 900_000,
          result: { outcome: { outcome: "selected", optionId: "allow" } }
        })
        yield* waitFor(() => answer.value !== undefined || answer.failure !== undefined, "the Client's answer")

        expect(answer.failure).toBeUndefined()
        expect(answer.value).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
        yield* harness.close
      })
    )
  })

  test("a malformed line is warned and ignored without stopping the loop", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        yield* harness.sendRaw("{this is not json\n")
        // Valid JSON, invalid JSON-RPC shape: parseLine fails, the loop still
        // treats it as a malformed line instead of dying.
        yield* harness.sendRaw('{"jsonrpc":"2.0","id":true}\n')
        yield* waitFor(
          () => harness.warnings.filter((line) => line.includes("non-JSON")).length === 2,
          "both malformed-line warns"
        )
        yield* openSession(harness)
        expect(harness.frames.some((frame) => frame.id === 1)).toBe(true)
        yield* harness.close
      })
    )
  })

  test("a failing request answers with a JSON-RPC error; a failing notification only warns", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        yield* harness.send({ jsonrpc: "2.0", id: 9, method: "no/such/method", params: {} })
        yield* waitFor(() => harness.frames.some((frame) => frame.id === 9), "the error response")
        const failed = harness.frames.find((frame) => frame.id === 9) as { error: { message: string } }
        expect(failed.error.message).toContain("unsupported ACP method")

        yield* harness.send({ jsonrpc: "2.0", method: "no/such/method", params: {} })
        yield* waitFor(
          () => harness.warnings.some((line) => line.includes("notification no/such/method failed")),
          "the notification warn"
        )
        yield* harness.close
      })
    )
  })
})

describe("transport client requests", () => {
  test("a Client error response rejects the waiting request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        yield* openSession(harness)

        const answer: { failure?: unknown } = {}
        yield* Effect.forkDetach(
          harness.transport
            .clientRequest("session/request_permission", {})
            .pipe(Effect.catchCause((cause) => Effect.sync(() => void (answer.failure = cause))))
        )
        yield* waitFor(
          () => harness.frames.some((frame) => frame.id === 900_000),
          "the permission ask to reach the Client"
        )
        yield* harness.send({ jsonrpc: "2.0", id: 900_000, error: { code: -1, message: "client said no" } })
        yield* waitFor(() => answer.failure !== undefined, "the Client's error to reject the request")

        expect(String(answer.failure)).toContain("client said no")
        yield* harness.close
      })
    )
  })

  test("an unanswered Client request times out with ClientRequestError", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ timeoutMs: 10 })
        const failure = yield* harness.transport.clientRequest("session/request_permission", {}).pipe(Effect.flip)
        expect(failure._tag).toBe("ClientRequestError")
        expect(failure.message).toContain("timed out")
        yield* harness.close
      })
    )
  })
})

describe("transport writer", () => {
  test("concurrent frames are never interleaved on stdout", async () => {
    const chunks: string[] = []
    const transport = makeTransport({
      // Splits every frame in two with a yield in between: an unserialized
      // writer interleaves the halves of the two frames.
      write: (raw) =>
        Effect.gen(function* () {
          const half = Math.floor(raw.length / 2)
          chunks.push(raw.slice(0, half))
          yield* Effect.yieldNow
          chunks.push(raw.slice(half))
        }),
      log: mockLog,
      timeoutMs: 1_000
    })

    await Effect.runPromise(
      Effect.all(
        [
          transport.writeLine({ jsonrpc: "2.0", id: 1, pad: "a".repeat(200) }),
          transport.writeLine({ jsonrpc: "2.0", id: 2, pad: "b".repeat(200) })
        ],
        { concurrency: "unbounded" }
      )
    )

    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line !== "")
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2])
  })
})

/**
 * Inbound half of the ACP transport: stdin lines in, JSON-RPC frames out.
 *
 * Every line is dispatched on its own fiber. A `session/prompt` stays open for
 * the whole Turn (`Deferred.await` in server.ts), and two messages the Client
 * sends *while* that Turn is in flight arrive on the same stdin:
 * `session/cancel` (the Stop button) and the answer to a
 * `session/request_permission` / `elicitation/create` ask. A sequential
 * `Stream.runForEach` queued both behind the Turn — Stop did nothing until the
 * Turn ended on its own, and the ask timed out after
 * `CLIENT_REQUEST_TIMEOUT_MS` and denied the tool call.
 *
 * Handlers now run concurrently, so stdout is serialized instead: the writer
 * holds a Semaphore permit for a whole frame, keeping one JSON-RPC message per
 * line (the Client's ndjson parser ends the session on a malformed line).
 *
 * Ordering is unchanged where the protocol depends on it: the Client awaits
 * each request before sending the next, so per-line fibers cannot reorder
 * anything the Client observes.
 */
import { Deferred, Effect, Result, Semaphore, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { AcpMethodError } from "../errors.ts"
import { ClientRequestError } from "../errors.ts"
import {
  clientRequest as clientRequestMessage,
  encodeLine,
  errorPayload,
  errorResponse,
  parseLine,
  successResponse,
  type JsonRpcResponse
} from "../jsonrpc.ts"
import type { Log } from "../log.ts"

export interface Transport {
  /** Serialized stdout writer: one frame per call, never interleaved. */
  readonly writeLine: (message: unknown) => Effect.Effect<void, PlatformError>
  /** Ask the Client something (permission/elicitation) and await its answer. */
  readonly clientRequest: (
    method: string,
    params: unknown
  ) => Effect.Effect<unknown, ClientRequestError | PlatformError>
  /** Route one decoded inbound response to the `clientRequest` waiting on its id. */
  readonly routeResponse: (response: JsonRpcResponse) => void
}

export interface TransportDeps {
  /** Raw writer for one already-encoded frame. */
  readonly write: (line: string) => Effect.Effect<void, PlatformError>
  readonly log: Log["Service"]
  readonly timeoutMs: number
  /**
   * First id used for Bridge→Client requests. Kept in its own range so it can
   * never collide with an id the Client chose.
   */
  readonly firstRequestId?: number
}

export const makeTransport = (deps: TransportDeps): Transport => {
  const writeMutex = Semaphore.makeUnsafe(1)
  const pending = new Map<number, Deferred.Deferred<unknown, ClientRequestError>>()
  let nextRequestId = deps.firstRequestId ?? 900_000

  const writeLine = (message: unknown): Effect.Effect<void, PlatformError> =>
    writeMutex.withPermits(1)(deps.write(encodeLine(message)))

  const clientRequest = (method: string, params: unknown): Effect.Effect<unknown, ClientRequestError | PlatformError> =>
    Effect.gen(function* () {
      const id = nextRequestId++
      yield* writeLine(clientRequestMessage(id, method, params))
      const deferred = Deferred.makeUnsafe<unknown, ClientRequestError>()
      pending.set(id, deferred)
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: deps.timeoutMs,
          orElse: () =>
            Effect.fail(
              new ClientRequestError({ message: `client request ${method} timed out (client never answered)` })
            )
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(id)))
      )
    })

  const routeResponse = (response: JsonRpcResponse): void => {
    const numId = typeof response.id === "number" ? response.id : Number(response.id)
    const entry = pending.get(numId)
    if (entry === undefined) return
    pending.delete(numId)
    if (response.error !== undefined) {
      Deferred.doneUnsafe(
        entry,
        Effect.fail(new ClientRequestError({ message: response.error.message ?? "client returned error" }))
      )
    } else {
      Deferred.doneUnsafe(entry, Effect.succeed(response.result))
    }
  }

  return { writeLine, clientRequest, routeResponse }
}

export interface InboundLoopDeps {
  readonly stdin: Stream.Stream<Uint8Array, PlatformError>
  readonly transport: Transport
  readonly log: Log["Service"]
  readonly handle: (method: string, params: Record<string, unknown>) => Effect.Effect<unknown, AcpMethodError>
}

/**
 * Reads stdin to EOF. Line-level failures never escape: decode errors become a
 * stderr note (Malformed) or a JSON-RPC error response / warn log (handler
 * failures), per the pre-rewrite wire contract. The only failure left is
 * `PlatformError` from the stdin stream and stdout writes, which genuinely
 * ends the process.
 */
export const runInboundLoop = (deps: InboundLoopDeps): Effect.Effect<void, PlatformError> =>
  Stream.runDrain(
    Stream.splitLines(Stream.decodeText(deps.stdin)).pipe(
      Stream.mapEffect((line) => handleLine(deps, line), { concurrency: "unbounded" })
    )
  )

const handleLine = (deps: InboundLoopDeps, line: string): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    const { log, transport } = deps
    const trimmed = line.trim()
    if (trimmed === "") return
    const outcome = yield* parseLine(trimmed).pipe(Effect.orElseSucceed(() => ({ _tag: "Malformed" as const })))
    if (outcome._tag === "Malformed") {
      yield* log.warn("[transport] non-JSON line on stdin (ignored)")
      return
    }
    if (outcome._tag !== "Message") return
    const inbound = outcome.inbound

    // Response to one of our client-side requests (permission asks)
    if (inbound._tag === "Response") {
      transport.routeResponse(inbound.response)
      return
    }

    const isRequest = inbound._tag === "Request"
    const method = inbound._tag === "Request" ? inbound.request.method : inbound.notification.method
    const params = inbound._tag === "Request" ? inbound.request.params : inbound.notification.params
    const id = inbound._tag === "Request" ? inbound.request.id : undefined

    const outcomeResult = yield* deps.handle(method, params).pipe(Effect.result)
    if (!Result.isSuccess(outcomeResult)) {
      const error = outcomeResult.failure
      if (isRequest && id !== undefined) {
        yield* transport.writeLine(errorResponse(id, errorPayload(error.message)))
      } else {
        yield* log.warn(`[transport] notification ${method} failed: ${error.message}`)
      }
      return
    }
    if (isRequest && id !== undefined) {
      yield* transport.writeLine(successResponse(id, outcomeResult.success))
    }
  })

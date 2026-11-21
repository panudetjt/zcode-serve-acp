/**
 * JSON-RPC 2.0 over newline-delimited stdio (the ACP transport).
 *
 * Inbound lines are decoded with Schema — malformed JSON is reported as
 * `Malformed` so the caller can note it on stderr and ignore it (wire
 * contract from the pre-rewrite bin.ts). Outbound messages are written
 * through the Stdio sink, so writes get the platform's backpressure handling.
 */
import { Effect, Result, Schema } from "effect"
import { DecodeError } from "./errors.ts"

export const JsonRpcId = Schema.Union([Schema.Finite, Schema.String])
export type JsonRpcId = typeof JsonRpcId.Type

export const JsonRpcErrorObject = Schema.Struct({
  code: Schema.Finite,
  message: Schema.String
})
export type JsonRpcErrorObject = typeof JsonRpcErrorObject.Type

/** Anything a client sends us: request, notification, or response. */
export const JsonRpcMessage = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: Schema.optional(JsonRpcId),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcErrorObject)
})
export type JsonRpcMessage = typeof JsonRpcMessage.Type

export interface JsonRpcRequest {
  readonly id: JsonRpcId
  readonly method: string
  readonly params: Record<string, unknown>
}
export interface JsonRpcNotification {
  readonly method: string
  readonly params: Record<string, unknown>
}
export interface JsonRpcResponse {
  readonly id: JsonRpcId
  readonly result?: unknown
  readonly error?: JsonRpcErrorObject
}

export type Inbound =
  | { readonly _tag: "Request"; readonly request: JsonRpcRequest }
  | { readonly _tag: "Notification"; readonly notification: JsonRpcNotification }
  | { readonly _tag: "Response"; readonly response: JsonRpcResponse }

export type ParseOutcome =
  | { readonly _tag: "Message"; readonly inbound: Inbound }
  /** failed JSON.parse — the pre-rewrite bridge noted this on stderr */
  | { readonly _tag: "Malformed" }
  /** parsed but neither request, notification, nor response */
  | { readonly _tag: "Ignored" }

const decodeMessage = Schema.decodeUnknownEffect(JsonRpcMessage, {
  onExcessProperty: "ignore"
})

export const parseLine = (line: string): Effect.Effect<ParseOutcome, DecodeError> =>
  Effect.gen(function* () {
    // The caught value is discarded by the `Malformed` outcome below (the
    // pre-rewrite bin.ts noted it on stderr and ignored it). The DecodeError
    // exists only to keep the catch typed instead of `unknown` — rendering it
    // here would be dead work.
    const parsed = yield* Effect.try({
      try: () => JSON.parse(line),
      catch: () => new DecodeError({ location: "jsonrpc/inbound", message: "malformed JSON on stdin" })
    }).pipe(Effect.result)
    if (!Result.isSuccess(parsed)) return { _tag: "Malformed" }
    const raw: unknown = parsed.success
    const msg = yield* decodeMessage(raw).pipe(
      Effect.mapError((issue) => new DecodeError({ location: "jsonrpc/inbound", message: issue.message }))
    )
    if (msg.method !== undefined) {
      const params = (msg.params ?? {}) as Record<string, unknown>
      return msg.id !== undefined
        ? {
            _tag: "Message",
            inbound: { _tag: "Request", request: { id: msg.id, method: msg.method, params } }
          }
        : { _tag: "Message", inbound: { _tag: "Notification", notification: { method: msg.method, params } } }
    }
    if (msg.id !== undefined) {
      return {
        _tag: "Message",
        inbound: {
          _tag: "Response",
          response: {
            id: msg.id,
            ...(msg.result !== undefined ? { result: msg.result } : {}),
            ...(msg.error !== undefined ? { error: msg.error } : {})
          }
        }
      }
    }
    return { _tag: "Ignored" }
  })

export const errorPayload = (message: string): JsonRpcErrorObject => ({
  code: -32000,
  message
})

/** serialize one outbound message to a wire line. */
export const encodeLine = (message: unknown): string => `${JSON.stringify(message)}\n`

/** JSON-RPC envelope helpers. */
export const notification = (method: string, params: unknown): unknown => ({
  jsonrpc: "2.0",
  method,
  params
})

export const successResponse = (id: JsonRpcId, result: unknown): unknown => ({
  jsonrpc: "2.0",
  id,
  result
})

export const errorResponse = (id: JsonRpcId, error: JsonRpcErrorObject): unknown => ({
  jsonrpc: "2.0",
  id,
  error
})

export const clientRequest = (id: JsonRpcId, method: string, params: unknown): unknown => ({
  jsonrpc: "2.0",
  id,
  method,
  params
})

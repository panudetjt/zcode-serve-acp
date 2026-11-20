/**
 * Typed error taxonomy for the bridge.
 *
 * Every failure crossing a module boundary is a tagged error — this replaces
 * the pre-rewrite "throw generic Error + hardcoded JSON-RPC -32000". bin.ts
 * serializes any of these to the ACP client as code -32000 with the message,
 * preserving the wire contract.
 */
import { Effect, Result, Schema } from "effect";

/**
 * Run an effect, logging (optionally) and swallowing any failure.
 *
 * v4.1.4 has no catch-all combinator with usable data-last typing, so this
 * helper — built on `Effect.result` — is THE project-wide pattern for the
 * pre-rewrite "try/catch-and-continue" sites (best-effort workspace init,
 * skills listing, interaction fallbacks, …). Best-effort steps must stay
 * best-effort: a failure here never aborts the surrounding flow.
 */
export const tolerate = <A, E, E2 = never>(
  effect: Effect.Effect<A, E>,
  onFail?: (cause: E) => Effect.Effect<void, E2>,
): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    if (!Result.isSuccess(result)) {
      if (onFail !== undefined) {
        // orElseSucceed swallows whatever onFail fails with (E2), so the
        // surrounding flow still sees a `never` error channel.
        yield* Effect.orElseSucceed(onFail(result.failure), () => undefined);
      }
      return undefined;
    }
    return result.success;
  });

export class DecodeError extends Schema.TaggedError<DecodeError, { readonly brand: unique symbol }>()("DecodeError", {
  /** what boundary failed to decode, e.g. "wire/frame" or "acp/params" */
  location: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class DiscoveryError extends Schema.TaggedError<DiscoveryError, { readonly brand: unique symbol }>()(
  "DiscoveryError",
  {
    message: Schema.String,
  },
) {}

export class SpawnError extends Schema.TaggedError<SpawnError, { readonly brand: unique symbol }>()("SpawnError", {
  bin: Schema.String,
  message: Schema.String,
}) {}

export class CapabilityError extends Schema.TaggedError<CapabilityError, { readonly brand: unique symbol }>()(
  "CapabilityError",
  {
    status: Schema.optional(Schema.Finite),
    message: Schema.String,
  },
) {}

export class ChannelClosed extends Schema.TaggedError<ChannelClosed, { readonly brand: unique symbol }>()(
  "ChannelClosed",
  {
    reason: Schema.String,
  },
) {}

export class ChannelOpenError extends Schema.TaggedError<ChannelOpenError, { readonly brand: unique symbol }>()(
  "ChannelOpenError",
  {
    message: Schema.String,
  },
) {}

export class ClientRequestError extends Schema.TaggedError<ClientRequestError, { readonly brand: unique symbol }>()(
  "ClientRequestError",
  {
    message: Schema.String,
  },
) {}

/** The daemon answered a channel call with PromiseError. */
export class RpcError extends Schema.TaggedError<RpcError, { readonly brand: unique symbol }>()("RpcError", {
  channel: Schema.String,
  method: Schema.String,
  message: Schema.String,
}) {}

/** A channel call exceeded its budget; PromiseCancel was sent to the daemon. */
export class RpcTimeout extends Schema.TaggedError<RpcTimeout, { readonly brand: unique symbol }>()("RpcTimeout", {
  channel: Schema.String,
  method: Schema.String,
  timeoutMs: Schema.Finite,
}) {}

export class SessionError extends Schema.TaggedError<SessionError, { readonly brand: unique symbol }>()(
  "SessionError",
  {
    message: Schema.String,
  },
) {}

/** Failure while driving a permission/elicitation interaction. */
export class InteractionError extends Schema.TaggedError<InteractionError, { readonly brand: unique symbol }>()(
  "InteractionError",
  {
    interactionId: Schema.String,
    message: Schema.String,
  },
) {}

/** Any failure from an ACP method handler — the JSON-RPC error payload. */
export class AcpMethodError extends Schema.TaggedError<AcpMethodError, { readonly brand: unique symbol }>()(
  "AcpMethodError",
  {
    method: Schema.String,
    message: Schema.String,
  },
) {}

/** Human-readable rendering used for JSON-RPC error messages and logs. */
export const renderError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

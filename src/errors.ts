/**
 * Typed error taxonomy for the bridge.
 *
 * Every failure crossing a module boundary is a tagged error — this replaces
 * the pre-rewrite "throw generic Error + hardcoded JSON-RPC -32000". bin.ts
 * serializes any of these to the ACP client as code -32000 with the message,
 * preserving the wire contract.
 */
import { Schema } from "effect";

export class DecodeError extends Schema.TaggedError<DecodeError>()("DecodeError", {
  /** what boundary failed to decode, e.g. "wire/frame" or "acp/params" */
  location: Schema.String,
  message: Schema.String,
  cause: Schema.optionalWith(Schema.Defect(), { as: "Option" }),
}) {}

export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()("DiscoveryError", {
  message: Schema.String,
}) {}

export class SpawnError extends Schema.TaggedError<SpawnError>()("SpawnError", {
  bin: Schema.String,
  message: Schema.String,
}) {}

export class CapabilityError extends Schema.TaggedError<CapabilityError>()("CapabilityError", {
  status: Schema.optional(Schema.Number),
  message: Schema.String,
}) {}

export class ChannelClosed extends Schema.TaggedError<ChannelClosed>()("ChannelClosed", {
  reason: Schema.String,
}) {}

/** The daemon answered a channel call with PromiseError. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  channel: Schema.String,
  method: Schema.String,
  message: Schema.String,
}) {}

/** A channel call exceeded its budget; PromiseCancel was sent to the daemon. */
export class RpcTimeout extends Schema.TaggedError<RpcTimeout>()("RpcTimeout", {
  channel: Schema.String,
  method: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", {
  message: Schema.String,
}) {}

/** Failure while driving a permission/elicitation interaction. */
export class InteractionError extends Schema.TaggedError<InteractionError>()("InteractionError", {
  interactionId: Schema.String,
  message: Schema.String,
}) {}

/** Any failure from an ACP method handler — the JSON-RPC error payload. */
export class AcpMethodError extends Schema.TaggedError<AcpMethodError>()("AcpMethodError", {
  method: Schema.String,
  message: Schema.String,
}) {}

/** Human-readable rendering used for JSON-RPC error messages and logs. */
export const renderError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

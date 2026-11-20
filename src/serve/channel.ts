/**
 * Channel RPC client over the binary WS protocol — the rewrite of the
 * pre-rewrite ChannelClient: `call("zcode-agent", method, arg)` mirrors the
 * upstream ChannelClient (CALL=100 / RESULT=201 / ERROR=202 / EVENT=204).
 * The daemon sends [200] right after the socket opens; we also answer
 * server→client requests (interaction asks) on the same socket.
 *
 * Hand-rolled pending-promise maps and definite-assignment deferreds are
 * replaced by `Deferred`s and `Effect.timeout`; the WS dial goes through
 * `Socket.makeWebSocket` (handshake headers are first-class there), and the
 * read pump is a scoped fiber whose teardown closes the socket. Event
 * listeners and server requests run on detached fibers forked from the pump —
 * the same concurrency shape as the pre-rewrite `void` handlers, but
 * interruption-safe.
 */
import { Deferred, Effect, Result } from "effect";
import * as ScopeNS from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import {
  ChannelClosed,
  ChannelOpenError,
  DecodeError,
  RpcError,
  RpcTimeout,
  renderError,
  tolerate,
} from "../errors.ts";
import type { Log } from "../log.ts";
import { decodeRpcMessage, encodeRpcMessage, FrameSplitter, MSG } from "./wire.ts";

/**
 * Handler callbacks carry the app's own failure channel `E`, threaded from the
 * session layer (SessionHandlers) down from the ACP server — the channel layer
 * never widens it. Event dispatch tolerates `E` inline (a handler failure is a
 * warning, never a channel failure), so only `onClose` can surface `E` through
 * `failAll`/`close` to their caller.
 */
export type ChannelEventListener<E = never> = (data: unknown) => Effect.Effect<void, E>;
export type ServerRequestHandler<E = never> = (
  channelName: string,
  name: string,
  arg: unknown,
) => Effect.Effect<unknown, E>;

export interface ChannelHandlers<E = never> {
  /** daemon → client request (e.g. interaction requests) */
  readonly onRequest: ServerRequestHandler<E>;
  readonly onClose: (reason: string) => Effect.Effect<void, E>;
}

export { ChannelOpenError };

const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

const toBytes = (chunk: Uint8Array | string): Uint8Array =>
  typeof chunk === "string" ? Buffer.from(chunk, "utf8") : new Uint8Array(chunk);

const text = (cause: unknown): string => renderError(cause);

export class ChannelClient<E = never> {
  private nextId = 1_000;
  private readonly pending = new Map<number, Deferred.Deferred<unknown, RpcError | ChannelClosed>>();
  private readonly listeners = new Map<number, ChannelEventListener<E>>();
  private readonly eventByKey = new Map<string, { id: number; handler: ChannelEventListener<E> }>();
  private readonly splitter = new FrameSplitter();
  /** Settled on [200] handshake or failed with ChannelClosed when the pump dies. */
  private readonly initDeferred: Deferred.Deferred<void, ChannelClosed>;
  readonly closed: Deferred.Deferred<string, never>;
  private settled = false;

  private constructor(
    private readonly socket: Socket.Socket,
    private readonly writer: Socket.Writer,
    private readonly handlers: ChannelHandlers<E>,
    private readonly log: Log["Service"],
  ) {
    this.initDeferred = Deferred.makeUnsafe<void, ChannelClosed>();
    this.closed = Deferred.makeUnsafe<string, never>();
  }

  /**
   * Dial the daemon channel. The pump runs in the CALLER's Scope (provide one
   * with `Scope.provide`); closing it tears down the read loop and socket.
   *
   * Dial failures never surface as a typed failure of THIS effect: the WS
   * acquisition runs lazily inside the socket's reader, so every failure
   * (refused dial, constructor throw, async open error) arrives through
   * pumpReader → failAll → the handshake await below, which maps it to
   * ChannelOpenError. (A pre-rewrite "dial failed" mapError here was dead —
   * removed when coverage proved nothing could reach it.)
   */
  static readonly connect = <E = never>(
    url: string,
    headers: Record<string, string>,
    handlers: ChannelHandlers<E>,
    log: Log["Service"],
  ): Effect.Effect<ChannelClient<E>, ChannelOpenError, ScopeNS.Scope | Socket.WebSocketConstructor> =>
    Effect.gen(function* () {
      yield* log.debug(`[channel] connecting ${url.replace(/token=[^&]*/, "token=…")}`);
      const socket = yield* Socket.makeWebSocket(url, { headers });
      const writer = yield* socket.writer;
      const client = yield* ChannelClient.forSocket(socket, writer, handlers, log);

      // The daemon sends [200] right after the socket opens.
      yield* Deferred.await(client.initDeferred).pipe(
        Effect.timeout(HANDSHAKE_TIMEOUT_MS),
        Effect.mapError(() => new ChannelOpenError({ message: "zcode server channel handshake timed out" })),
      );
      return client;
    });

  /**
   * Attach the pump to an already-dialed socket — the seam `connect` uses
   * after the dial, exposed for tests to inject fake readers/writers. The
   * pump runs in the CALLER's Scope (provide one with `Scope.provide`).
   */
  static readonly forSocket = <E = never>(
    socket: Socket.Socket,
    writer: Socket.Writer,
    handlers: ChannelHandlers<E>,
    log: Log["Service"],
  ): Effect.Effect<ChannelClient<E>, never, ScopeNS.Scope> =>
    Effect.gen(function* () {
      const client = new ChannelClient(socket, writer, handlers, log);
      yield* client.pumpReader().pipe(
        Effect.catchCause((cause) => client.failAll(`zcode server channel closed (${text(cause)})`)),
        Effect.forkScoped,
      );
      return client;
    });

  /**
   * Continuous read loop; fails with the socket error when the channel dies
   * (`Reader.pull` surfaces every termination — clean close included — as a
   * `SocketError`). Frame decode failures do not escape: `dispatchFrame`
   * swallows them into a warning log.
   */
  private pumpReader(): Effect.Effect<void, Socket.SocketError, ScopeNS.Scope> {
    return Effect.gen({ self: this }, function* () {
      const reader = yield* this.socket.reader;
      for (;;) {
        const batch = yield* reader.pull;
        for (const chunk of batch) {
          for (const frame of this.splitter.push(toBytes(chunk))) {
            yield* this.dispatchFrame(frame);
          }
        }
      }
    });
  }

  private dispatchFrame(frame: Uint8Array): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // The wire codec throws DecodeError on malformed frames (13-byte header,
      // VQL varints — see wire.ts); an undecodable frame is never fatal for the
      // channel, so this is captured into a warning log below. The catch types
      // the thrown value into the taxonomy instead of surfacing it bare.
      const decoded = yield* Effect.try({
        try: () => decodeRpcMessage(frame),
        catch: (cause) => new DecodeError({ location: "channel/frame", message: renderError(cause), cause }),
      }).pipe(Effect.result);
      if (!Result.isSuccess(decoded)) {
        yield* this.log.warn(`[channel] undecodable frame ignored: ${text(decoded.failure)}`);
        return;
      }
      const msg = decoded.success;
      const type = msg.header[0];
      if (type === MSG.Initialize) {
        Deferred.doneUnsafe(this.initDeferred, Effect.void);
        return;
      }
      const id = msg.header[1] as number;
      if (type === MSG.PromiseSuccess) {
        const deferred = this.pending.get(id);
        if (deferred !== undefined) {
          this.pending.delete(id);
          Deferred.doneUnsafe(deferred, Effect.succeed(msg.body));
        }
        return;
      }
      if (type === MSG.PromiseError || type === MSG.PromiseErrorObj) {
        const deferred = this.pending.get(id);
        if (deferred !== undefined) {
          this.pending.delete(id);
          const payload = msg.body as { message?: string } | undefined;
          Deferred.doneUnsafe(
            deferred,
            Effect.fail(
              new RpcError({
                channel: "zcode",
                method: "?",
                message: payload?.message ?? `zcode channel error (type ${type})`,
              }),
            ),
          );
        }
        return;
      }
      if (type === MSG.EventFire) {
        const handler = this.listeners.get(id);
        if (handler !== undefined) {
          // Inline (not forked): frame handlers drive a sequential state
          // machine, so event order must be preserved — same as the
          // pre-rewrite synchronous listener dispatch.
          yield* tolerate(handler(msg.body), (cause) =>
            this.log.warn(`[channel] event handler failed: ${text(cause)}`),
          );
        }
        return;
      }
      if (type === MSG.EventError) {
        yield* this.log.debug(`[channel] event error id=${id}`, msg.body);
        return;
      }
      if (type === MSG.Promise) {
        // server→client request (e.g. interaction requests): [100, id, channelName, name]
        const [, , channelName, name] = msg.header as [number, number, string, string];
        yield* Effect.forkDetach(this.handleServerRequest(id, channelName, name, msg.body));
        return;
      }
      yield* this.log.debug(`[channel] unhandled frame type ${type}`, msg.header);
    });
  }

  /**
   * Server→client request handling never fails: the handler outcome (success
   * or failure) is rendered back to the daemon as a [202]/[203] frame, and any
   * write failure is swallowed — a dead channel is already reported by the
   * pump through `failAll`.
   */
  private handleServerRequest(id: number, channelName: string, name: string, arg: unknown): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const outcome = yield* Effect.result(this.handlers.onRequest(channelName, name, arg));
      if (Result.isFailure(outcome)) {
        const cause = outcome.failure;
        yield* this.write(
          encodeRpcMessage([MSG.PromiseErrorObj, id], {
            message: renderError(cause),
            name: cause instanceof Error ? cause.name : "Error",
          }),
        ).pipe(Effect.orElseSucceed(() => undefined));
        return;
      }
      yield* this.write(encodeRpcMessage([MSG.PromiseSuccess, id], outcome.success)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
    });
  }

  private failAll(reason: string): Effect.Effect<void, E> {
    return Effect.gen({ self: this }, function* () {
      if (this.settled) return;
      this.settled = true;
      const error = new ChannelClosed({ reason });
      for (const deferred of this.pending.values()) Deferred.doneUnsafe(deferred, Effect.fail(error));
      this.pending.clear();
      Deferred.doneUnsafe(this.initDeferred, Effect.fail(error));
      Deferred.doneUnsafe(this.closed, Effect.succeed(reason));
      yield* this.handlers.onClose(reason);
    });
  }

  private write(bytes: Uint8Array): Effect.Effect<void, ChannelClosed> {
    if (this.settled) {
      return Effect.fail(new ChannelClosed({ reason: "zcode server channel already closed" }));
    }
    return this.writer
      .write(bytes)
      .pipe(
        Effect.mapError((cause) => new ChannelClosed({ reason: `zcode server channel write failed: ${text(cause)}` })),
      );
  }

  /** `channel.call("zcode-agent", "sendPrompt", arg)` equivalent. */
  call(
    channelName: string,
    method: string,
    arg?: unknown,
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ): Effect.Effect<unknown, RpcError | RpcTimeout | ChannelClosed> {
    return Effect.gen({ self: this }, function* () {
      const id = this.nextId++;
      const deferred = Deferred.makeUnsafe<unknown, RpcError | ChannelClosed>();
      this.pending.set(id, deferred);
      yield* this.write(encodeRpcMessage([MSG.Promise, id, channelName, method], [arg])).pipe(
        Effect.catchTag("ChannelClosed", (error) => {
          this.pending.delete(id);
          return Effect.fail(error);
        }),
      );
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new RpcTimeout({ channel: channelName, method, timeoutMs })),
        }),
        Effect.ensuring(
          Effect.gen({ self: this }, function* () {
            const stillPending = this.pending.get(id) === deferred;
            this.pending.delete(id);
            if (stillPending) {
              yield* this.write(encodeRpcMessage([MSG.PromiseCancel, id])).pipe(Effect.orElseSucceed(() => undefined));
            }
          }),
        ),
      );
    });
  }

  /**
   * `channel.listen("zcode-agent", event, arg, handler)` equivalent. Returns a
   * disposer; the write failures inside it are already swallowed, so the
   * disposer never fails and callers can drain it bare.
   */
  listen(
    channelName: string,
    event: string,
    arg: unknown,
    handler: ChannelEventListener<E>,
  ): Effect.Effect<Effect.Effect<void>> {
    return Effect.map(
      Effect.gen({ self: this }, function* () {
        const id = this.nextId++;
        this.listeners.set(id, handler);
        this.eventByKey.set(`${channelName}:${event}`, { id, handler });
        yield* this.write(encodeRpcMessage([MSG.EventListen, id, channelName, event], arg ?? undefined)).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        return id;
      }),
      (id) =>
        Effect.gen({ self: this }, function* () {
          this.listeners.delete(id);
          this.eventByKey.delete(`${channelName}:${event}`);
          yield* this.write(encodeRpcMessage([MSG.EventDispose, id])).pipe(Effect.orElseSucceed(() => undefined));
        }),
    );
  }

  /**
   * Close the channel on the client's side. Any failure comes from the
   * app-supplied `onClose` handler (`E`); the channel's own state is already
   * settled before the handler runs, so callers may tolerate this.
   */
  close(): Effect.Effect<void, E> {
    return Effect.gen({ self: this }, function* () {
      yield* this.failAll("zcode server channel closed by client");
    });
  }
}

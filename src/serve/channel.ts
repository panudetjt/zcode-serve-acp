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
import { Deferred, Effect } from "effect";
import * as ScopeNS from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { ChannelClosed, RpcError, RpcTimeout, renderError, tolerate } from "../errors.ts";
import type { Log } from "../log.ts";
import { decodeRpcMessage, encodeRpcMessage, FrameSplitter, MSG } from "./wire.ts";

export type ChannelEventListener = (data: unknown) => Effect.Effect<void, unknown>;
export type ServerRequestHandler = (channelName: string, name: string, arg: unknown) => Effect.Effect<unknown, unknown>;

export interface ChannelHandlers {
  /** daemon → client request (e.g. interaction requests) */
  readonly onRequest: ServerRequestHandler;
  readonly onClose: (reason: string) => Effect.Effect<void, unknown>;
}

export class ChannelOpenError extends Error {}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

const toBytes = (chunk: Uint8Array | string): Uint8Array =>
  typeof chunk === "string" ? Buffer.from(chunk, "utf8") : new Uint8Array(chunk);

const text = (cause: unknown): string => renderError(cause);

export class ChannelClient {
  private nextId = 1_000;
  private readonly pending = new Map<number, Deferred.Deferred<unknown, RpcError | ChannelClosed>>();
  private readonly listeners = new Map<number, ChannelEventListener>();
  private readonly eventByKey = new Map<string, { id: number; handler: ChannelEventListener }>();
  private readonly splitter = new FrameSplitter();
  private readonly initDeferred: Deferred.Deferred<void, unknown>;
  readonly closed: Deferred.Deferred<string, never>;
  private settled = false;

  private constructor(
    private readonly socket: Socket.Socket,
    private readonly writer: Socket.Writer,
    private readonly handlers: ChannelHandlers,
    private readonly log: Log["Service"],
  ) {
    this.initDeferred = Deferred.makeUnsafe<void, unknown>();
    this.closed = Deferred.makeUnsafe<string, never>();
  }

  /**
   * Dial the daemon channel. The pump runs in the CALLER's Scope (provide one
   * with `Scope.provide`); closing it tears down the read loop and socket.
   */
  static readonly connect = (
    url: string,
    headers: Record<string, string>,
    handlers: ChannelHandlers,
    log: Log["Service"],
  ): Effect.Effect<ChannelClient, ChannelOpenError, ScopeNS.Scope | Socket.WebSocketConstructor> =>
    Effect.gen(function* () {
      yield* log.debug(`[channel] connecting ${url.replace(/token=[^&]*/, "token=…")}`);
      const socket = yield* Socket.makeWebSocket(url, { headers }).pipe(
        Effect.mapError((cause) => new ChannelOpenError(`zcode server channel dial failed: ${text(cause)}`)),
      );
      const writer = yield* socket.writer;
      const client = new ChannelClient(socket, writer, handlers, log);

      yield* client.pumpReader().pipe(
        Effect.catchCause((cause) => client.failAll(`zcode server channel closed (${text(cause)})`)),
        Effect.forkScoped,
      );

      // The daemon sends [200] right after the socket opens.
      yield* Deferred.await(client.initDeferred).pipe(
        Effect.timeout(HANDSHAKE_TIMEOUT_MS),
        Effect.mapError(() => new ChannelOpenError("zcode server channel handshake timed out")),
      );
      return client;
    });

  /** Continuous read loop; fails with the socket error when the channel dies. */
  private pumpReader(): Effect.Effect<void, unknown, ScopeNS.Scope> {
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
      let decoded: ReturnType<typeof decodeRpcMessage>;
      try {
        decoded = decodeRpcMessage(frame);
      } catch (cause) {
        yield* this.log.warn(`[channel] undecodable frame ignored: ${text(cause)}`);
        return;
      }
      const type = decoded.header[0];
      if (type === MSG.Initialize) {
        Deferred.doneUnsafe(this.initDeferred, Effect.void);
        return;
      }
      const id = decoded.header[1] as number;
      if (type === MSG.PromiseSuccess) {
        const deferred = this.pending.get(id);
        if (deferred !== undefined) {
          this.pending.delete(id);
          Deferred.doneUnsafe(deferred, Effect.succeed(decoded.body));
        }
        return;
      }
      if (type === MSG.PromiseError || type === MSG.PromiseErrorObj) {
        const deferred = this.pending.get(id);
        if (deferred !== undefined) {
          this.pending.delete(id);
          const payload = decoded.body as { message?: string } | undefined;
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
          yield* tolerate(handler(decoded.body), (cause) =>
            this.log.warn(`[channel] event handler failed: ${text(cause)}`),
          );
        }
        return;
      }
      if (type === MSG.EventError) {
        yield* this.log.debug(`[channel] event error id=${id}`, decoded.body);
        return;
      }
      if (type === MSG.Promise) {
        // server→client request (e.g. interaction requests): [100, id, channelName, name]
        const [, , channelName, name] = decoded.header as [number, number, string, string];
        yield* Effect.forkDetach(this.handleServerRequest(id, channelName, name, decoded.body));
        return;
      }
      yield* this.log.debug(`[channel] unhandled frame type ${type}`, decoded.header);
    });
  }

  private handleServerRequest(
    id: number,
    channelName: string,
    name: string,
    arg: unknown,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      let result: unknown;
      try {
        result = yield* this.handlers.onRequest(channelName, name, arg);
      } catch (cause) {
        yield* this.write(
          encodeRpcMessage([MSG.PromiseErrorObj, id], {
            message: renderError(cause),
            name: cause instanceof Error ? cause.name : "Error",
          }),
        ).pipe(Effect.orElseSucceed(() => undefined));
        return;
      }
      yield* this.write(encodeRpcMessage([MSG.PromiseSuccess, id], result)).pipe(Effect.orElseSucceed(() => undefined));
    });
  }

  private failAll(reason: string): Effect.Effect<void, unknown> {
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
        Effect.timeout(timeoutMs),
        Effect.catchTag("TimeoutError", () => Effect.fail(new RpcTimeout({ channel: channelName, method, timeoutMs }))),
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

  /** `channel.listen("zcode-agent", event, arg, handler)` equivalent. Returns dispose. */
  listen(
    channelName: string,
    event: string,
    arg: unknown,
    handler: ChannelEventListener,
  ): Effect.Effect<Effect.Effect<void, unknown>> {
    return Effect.gen({ self: this }, function* () {
      const id = this.nextId++;
      this.listeners.set(id, handler);
      this.eventByKey.set(`${channelName}:${event}`, { id, handler });
      yield* this.write(encodeRpcMessage([MSG.EventListen, id, channelName, event], arg ?? undefined)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return Effect.gen({ self: this }, function* () {
        this.listeners.delete(id);
        this.eventByKey.delete(`${channelName}:${event}`);
        yield* this.write(encodeRpcMessage([MSG.EventDispose, id])).pipe(Effect.orElseSucceed(() => undefined));
      });
    });
  }

  close(): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      yield* this.failAll("zcode server channel closed by client");
    });
  }
}

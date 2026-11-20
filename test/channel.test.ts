import { describe, expect, test } from "bun:test";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Socket from "effect/socket/Socket";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { Log } from "../src/log.ts";
import { ChannelClient } from "../src/serve/channel.ts";
import { decodeRpcMessage, encodeRpcMessage, FRAME_KIND_REGULAR, MSG, writeProtocolFrame } from "../src/serve/wire.ts";

describe("ChannelClient over WebSocket", () => {
  test("connect and handshake completes on MSG.Initialize [200]", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message() {},
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        { authorization: "test" },
        {
          onRequest: () => Effect.succeed(undefined),
          onClose: () => Effect.void,
        },
        log,
      );
      expect(client).toBeDefined();
      yield* client.close();
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("connect fails with ChannelOpenError on connection refused", async () => {
    const prog = Effect.gen(function* () {
      const log = yield* Log;
      return yield* ChannelClient.connect(
        "ws://127.0.0.1:59999",
        {},
        {
          onRequest: () => Effect.succeed(undefined),
          onClose: () => Effect.void,
        },
        log,
      );
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    const err = await Effect.runPromise(Effect.flip(prog));
    expect(err._tag).toBe("ChannelOpenError");
    expect(err.message).toContain("zcode server channel");
  });

  test("call handles success, rpc error (202 and 203), timeout, and cancellation", async () => {
    const serverReceived: any[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg);
          const decoded = decodeRpcMessage(raw);
          serverReceived.push(decoded);
          const type = decoded.header[0];
          const callId = decoded.header[1] as number;
          const method = decoded.header[3] as string;

          if (type === MSG.Promise) {
            if (method === "succeed") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, callId], { result: "ok" }));
            } else if (method === "failError") {
              ws.send(encodeRpcMessage([MSG.PromiseError, callId], { message: "call failed 202" }));
            } else if (method === "failObj") {
              ws.send(encodeRpcMessage([MSG.PromiseErrorObj, callId], { message: "call failed 203" }));
            }
            // If method === "slow", do not respond to test timeout
          }
        },
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        {
          onRequest: () => Effect.succeed(undefined),
          onClose: () => Effect.void,
        },
        log,
      );

      // 1. Success
      const res = yield* client.call("zcode-agent", "succeed", { foo: "bar" });
      expect(res).toEqual({ result: "ok" });

      // 2. PromiseError (202)
      const err202 = yield* Effect.flip(client.call("zcode-agent", "failError"));
      expect(err202._tag).toBe("RpcError");
      expect(err202.message).toBe("call failed 202");

      // 3. PromiseErrorObj (203)
      const err203 = yield* Effect.flip(client.call("zcode-agent", "failObj"));
      expect(err203._tag).toBe("RpcError");
      expect(err203.message).toBe("call failed 203");

      // 4. Timeout
      const errTimeout = yield* Effect.flip(client.call("zcode-agent", "slow", undefined, 50));
      expect(errTimeout._tag).toBe("RpcTimeout");
      if (errTimeout._tag === "RpcTimeout") {
        expect(errTimeout.method).toBe("slow");
      }

      yield* Effect.sleep(30);

      // Verify that PromiseCancel was sent
      const cancelMsg = serverReceived.find((m) => m.header[0] === MSG.PromiseCancel);
      expect(cancelMsg).toBeDefined();

      yield* client.close();

      // 5. Calling on closed channel fails with ChannelClosed
      const errClosed = yield* Effect.flip(client.call("zcode-agent", "succeed"));
      expect(errClosed._tag).toBe("ChannelClosed");
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("listen handles events, errors, listener failures, and unsubscription", async () => {
    const eventReceived: any[] = [];
    const eventDone = Deferred.makeUnsafe<void>();

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg);
          const decoded = decodeRpcMessage(raw);
          const type = decoded.header[0];
          const listenId = decoded.header[1] as number;

          if (type === MSG.EventListen) {
            // Fire an event
            ws.send(encodeRpcMessage([MSG.EventFire, listenId], { data: "hello-event" }));
            // Fire an event error (205)
            ws.send(encodeRpcMessage([MSG.EventError, listenId], { error: "bad event" }));
          }
        },
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        {
          onRequest: () => Effect.succeed(undefined),
          onClose: () => Effect.void,
        },
        log,
      );

      const dispose = yield* client.listen("zcode-agent", "onMessage", { topic: "test" }, (data) =>
        Effect.sync(() => {
          eventReceived.push(data);
          Deferred.doneUnsafe(eventDone, Effect.void);
        }),
      );

      yield* Deferred.await(eventDone);
      expect(eventReceived[0]).toEqual({ data: "hello-event" });

      // Test dispose unregisters and sends MSG.EventDispose
      yield* dispose;
      yield* client.close();
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("server-to-client request dispatch and response/error handling", async () => {
    let serverWs: any;
    const responsesReceived: any[] = [];
    const requestFinished = Deferred.makeUnsafe<void>();

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          serverWs = ws;
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg);
          const decoded = decodeRpcMessage(raw);
          responsesReceived.push(decoded);
          if (responsesReceived.length === 2) {
            Deferred.doneUnsafe(requestFinished, Effect.void);
          }
        },
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        {
          onRequest: (channelName, name, arg) => {
            if (name === "goodRequest") {
              return Effect.succeed({ echo: arg });
            }
            return Effect.fail(new Error("bad request forced failure"));
          },
          onClose: () => Effect.void,
        },
        log,
      );

      // Server sends a good request: [100, 501, "zcode", "goodRequest"]
      serverWs.send(encodeRpcMessage([MSG.Promise, 501, "zcode", "goodRequest"], { payload: 123 }));

      // Server sends a failing request: [100, 502, "zcode", "badRequest"]
      serverWs.send(encodeRpcMessage([MSG.Promise, 502, "zcode", "badRequest"], {}));

      // Server sends undecodable frame
      serverWs.send(new Uint8Array([99, 99, 99]));

      yield* Deferred.await(requestFinished);

      const successResp = responsesReceived.find((r) => r.header[1] === 501);
      expect(successResp?.header[0]).toBe(MSG.PromiseSuccess);
      expect(successResp?.body).toEqual({ echo: { payload: 123 } });

      const failResp = responsesReceived.find((r) => r.header[1] === 502);
      expect(failResp?.header[0]).toBe(MSG.PromiseErrorObj);
      expect((failResp?.body as any)?.message).toContain("bad request forced failure");

      yield* client.close();
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("server closing socket invokes onClose handler and fails pending deferreds", async () => {
    let serverWs: any;
    const closedDeferred = Deferred.makeUnsafe<string>();

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          serverWs = ws;
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message() {},
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        {
          onRequest: () => Effect.succeed(undefined),
          onClose: (reason) =>
            Effect.sync(() => {
              Deferred.doneUnsafe(closedDeferred, Effect.succeed(reason));
            }),
        },
        log,
      );

      // Start a call that never returns
      const pendingFiber = yield* Effect.forkScoped(client.call("zcode-agent", "hang", undefined, 10_000));

      // Close the server-side socket
      serverWs.close();

      const reason = yield* Deferred.await(closedDeferred);
      expect(typeof reason).toBe("string");

      const err = yield* Effect.flip(Fiber.join(pendingFiber));
      expect(err._tag).toBe("ChannelClosed");
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });
});

describe("dial and write failure fallbacks", () => {
  test("dial failure still surfaces as typed ChannelOpenError via the pump", async () => {
    const prog = Effect.gen(function* () {
      const log = yield* Log;
      return yield* ChannelClient.connect(
        "ws://127.0.0.1:59998",
        {},
        { onRequest: () => Effect.succeed(undefined), onClose: () => Effect.void },
        log,
      );
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    const err = await Effect.runPromise(Effect.flip(prog));
    expect(err._tag).toBe("ChannelOpenError");
    expect(err.message).toContain("zcode server channel");
  });

  test("writes after the channel settled fall back silently (request reply, dispose)", async () => {
    let serverWs: any;
    let clientRef: ChannelClient | undefined;

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          serverWs = ws;
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message() {},
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        {
          // Settling the channel inside the handler makes the reply write land
          // on the closed path — the fallback must swallow it, not throw.
          onRequest: (channelName, name) => {
            const answer =
              name === "boom" ? Effect.fail(new Error("forced handler failure")) : Effect.succeed({ ok: 1 });
            return (clientRef?.close() ?? Effect.void).pipe(Effect.andThen(answer));
          },
          onClose: () => Effect.void,
        },
        log,
      );
      clientRef = client;

      // success reply write lands on the settled channel
      serverWs.send(encodeRpcMessage([MSG.Promise, 601, "zcode", "ask"], { q: 1 }));
      yield* Effect.sleep(80);
      // error reply write lands on the settled channel too
      serverWs.send(encodeRpcMessage([MSG.Promise, 602, "zcode", "boom"], {}));
      yield* Effect.sleep(80);

      // dispose of a listener after close sends EventDispose on a settled channel
      const dispose = yield* client.listen("zcode-agent", "topic", undefined, () => Effect.void);
      yield* dispose;

      // The close really happened, and every write after it was swallowed:
      // awaiting the closed deferred resolves instead of hanging, and a late
      // call still gets the typed ChannelClosed rather than a defect.
      expect(yield* Deferred.await(client.closed)).toBe("zcode server channel closed by client");
      const late = yield* Effect.flip(client.call("zcode-agent", "x", undefined, 200));
      expect(late._tag).toBe("ChannelClosed");
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("a writer fault maps to ChannelClosed via the write fallback", async () => {
    // Bun's WS writer never errors in practice (closed-socket sends resolve
    // silently), so inject a broken writer through the forSocket seam to pin
    // the write-error → ChannelClosed mapping.
    const brokenWriter = {
      write: () => Effect.fail(new Error("writer fault")),
    } as unknown as Socket.Writer;
    const neverReader = { pull: Effect.never } as unknown as Socket.Reader;
    const socket = {
      reader: Effect.succeed(neverReader),
      writer: Effect.succeed(brokenWriter),
    } as unknown as Socket.Socket;

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.forSocket(
        socket,
        brokenWriter,
        { onRequest: () => Effect.succeed(undefined), onClose: () => Effect.void },
        log,
      );
      const err = yield* Effect.flip(client.call("zcode-agent", "x", undefined, 200));
      expect(err._tag).toBe("ChannelClosed");
      if (err._tag !== "ChannelClosed") return; // narrow the error union for the assertions below
      expect(err.reason).toContain("zcode server channel write failed");
      expect(err.reason).toContain("writer fault");
    }).pipe(Effect.provide(Log.layerQuiet), Effect.scoped);

    await Effect.runPromise(prog);
  });
});

describe("dispatchFrame edge branches", () => {
  test("undecodable frame is logged and ignored, channel stays usable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        async open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]));
          // let the client's dispatch pump attach before the edge frames land
          await new Promise((resolve) => setTimeout(resolve, 80));
          ws.send(encodeRpcMessage([MSG.EventError, 999, { message: "event error frame" }]));
          // unknown frame type → unhandled branch
          ws.send(encodeRpcMessage([42, 1, "whatever"]));
          // well-framed but truncated VQL body → decodeRpcMessage throws → warn+ignore
          ws.send(writeProtocolFrame(FRAME_KIND_REGULAR, 0, 0, new Uint8Array([0x05])));
        },
        message() {},
      },
    });

    const captured: string[] = [];
    const captureLog = Log.of({
      debugSync: (...parts: unknown[]) => {
        captured.push(parts.map((x) => String(x)).join(" "));
      },
      debug: (...parts: unknown[]) => Effect.sync(() => captured.push(parts.map((x) => String(x)).join(" "))),
      warn: (...parts: unknown[]) => Effect.sync(() => captured.push("WARN " + parts.map((x) => String(x)).join(" "))),
    });
    const prog = Effect.gen(function* () {
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        { onRequest: () => Effect.succeed(undefined), onClose: () => Effect.void },
        yield* Log,
      );
      expect(client).toBeDefined();
      // let the edge frames land and dispatch before closing
      yield* Effect.sleep(300);
      yield* client.close();
    }).pipe(
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Layer.succeed(Log, captureLog)),
      Effect.scoped,
    );

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
    const joined = captured.join("\n");
    expect(joined).toContain("event error id=999");
    expect(joined).toContain("unhandled frame type 42");
    expect(joined).toContain("undecodable frame ignored");
  });

  test("failing event handler is tolerated and channel keeps working", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg);
          const decoded = decodeRpcMessage(raw);
          if (decoded.header[0] === MSG.EventListen) {
            const listenId = decoded.header[1] as number;
            // echo the listen id back as an event so the registered handler runs
            ws.send(encodeRpcMessage([MSG.EventFire, listenId, { payload: "boom" }]));
          }
        },
      },
    });

    const prog = Effect.gen(function* () {
      const log = yield* Log;
      const client = yield* ChannelClient.connect(
        `ws://localhost:${server.port}`,
        {},
        { onRequest: () => Effect.succeed(undefined), onClose: () => Effect.void },
        log,
      );
      const disposeBoom = yield* client.listen("zcode-agent", "boom", undefined, () =>
        Effect.fail("handler failed on purpose"),
      );
      // give the event round-trip a moment, then prove the channel is still usable
      yield* Effect.sleep(120);
      const dispose = yield* client.listen("zcode-agent", "second", undefined, () => Effect.void);
      expect(typeof dispose).toBe("object");
      yield* disposeBoom.pipe(Effect.orElseSucceed(() => undefined));
      yield* dispose.pipe(Effect.orElseSucceed(() => undefined));
      yield* client.close();
    }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor), Effect.provide(Log.layerQuiet), Effect.scoped);

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });
});

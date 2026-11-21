import { describe, expect, test } from "bun:test";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { Log } from "../src/log.ts";
import { BridgeExit } from "../src/serve/bridge.ts";
import { Daemon } from "../src/serve/daemon.ts";
import { ServeSessionFactory } from "../src/serve/session.ts";
import { decodeRpcMessage, encodeRpcMessage, MSG } from "../src/serve/wire.ts";

// Recovery must never fire in the plain lifecycle tests — a fake that dies
// loudly (instead of exiting the test process) keeps that honest.
const fakeBridgeExit = BridgeExit.of({
  exit: (reason) => Effect.die(new Error(`BridgeExit requested in test: ${reason}`)),
});

describe("ServeSession lifecycle and operations", () => {
  test("full session lifecycle: createSession, sendPrompt, setMode, resolveInteraction, sendCommand, frame filtering, and dispose", async () => {
    const framesReceived: any[] = [];
    const lifecyclesReceived: any[] = [];
    const childFramesReceived: Array<{ childId: string; frame: any }> = [];
    const serverCalls: Array<{ channel: string; method: string; arg: any }> = [];

    const frameDone = Deferred.makeUnsafe<void>();
    const lifecycleDone = Deferred.makeUnsafe<void>();
    const childFrameDone = Deferred.makeUnsafe<void>();
    let framesListenId: number | undefined;

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
          const id = decoded.header[1] as number;
          const channel = decoded.header[2] as string;
          const method = decoded.header[3] as string;

          if (type === MSG.Promise) {
            const arg = (decoded.body as any[])?.[0];
            serverCalls.push({ channel, method, arg });

            if (channel === "project" && method === "saveProject") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { project: { id: "p-42" } }));
            } else if (channel === "zcode-agent" && method === "initialize") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { ok: true }));
            } else if (channel === "zcode-session" && method === "createSession") {
              ws.send(
                encodeRpcMessage([MSG.PromiseSuccess, id], {
                  sessionId: "daemon-sess-99",
                  session: { sessionId: "daemon-sess-99", mode: "plan" },
                  settings: {
                    model: {
                      current: { ref: { providerId: "zai", modelId: "glm-5" } },
                      available: [
                        {
                          ref: { providerId: "zai", modelId: "glm-5" },
                          label: "GLM 5",
                          providerLabel: "Z.AI",
                          contextWindow: 128000,
                          reasoning: { levels: [{ value: "max", label: "Max" }], defaultLevel: "max" },
                        },
                      ],
                    },
                  },
                  slashCommands: [{ name: "reset", description: "Reset chat" }, { name: "" }],
                }),
              );
            } else if (channel === "zcode-agent" && method === "subscribeConversationV4") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { subscribed: true }));
              if (arg?.sessionId === "child-sess-1" && framesListenId !== undefined) {
                // Child frame routed by topic; another session's frame stays dropped.
                ws.send(
                  encodeRpcMessage([MSG.EventFire, framesListenId], {
                    topic: "conversation/child-sess-1",
                    update: "child-token",
                  }),
                );
                ws.send(
                  encodeRpcMessage([MSG.EventFire, framesListenId], {
                    topic: "conversation/other-sess",
                    update: "still-ignored",
                  }),
                );
              }
            } else if (channel === "zcode-agent" && method === "unsubscribeConversationV4") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { unsubscribed: true }));
            } else if (channel === "zcode-agent" && method === "listSessionSubagents") {
              ws.send(
                encodeRpcMessage([MSG.PromiseSuccess, id], {
                  revision: 7,
                  childSessionIds: ["child-sess-1"],
                  running: [
                    {
                      childSessionId: "child-sess-1",
                      toolCallId: "agent-tc-1",
                      subagentType: "Explore",
                      title: "Scan repo",
                      status: "running",
                    },
                    { childSessionId: "no-type-or-status" },
                  ],
                  ended: {
                    total: 2,
                    items: [
                      { childSessionId: "child-sess-0", subagentType: "general", title: "Done", status: "success" },
                    ],
                  },
                }),
              );
            } else if (channel === "zcode-agent" && method === "helloConversationV4") {
              // the issue #5 pre-flight probe — must round-trip for the
              // liveness check to pass
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { hello: true }));
            } else if (channel === "skills" && method === "list") {
              ws.send(
                encodeRpcMessage([MSG.PromiseSuccess, id], {
                  skills: [
                    { name: " test-skill ", description: " a test skill ", path: "/path/to/skill", enabled: true },
                    { name: "disabled-skill", enabled: false },
                  ],
                }),
              );
            } else if (channel === "zcode-agent" && method === "sendPrompt") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { ok: true }));
            } else if (channel === "zcode-agent" && method === "setMode") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { ok: true }));
            } else if (channel === "zcode-agent" && method === "sendConversationCommandV4") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { commandResult: "done" }));
            }
          } else if (type === MSG.EventListen) {
            const eventName = decoded.header[3] as string;
            if (eventName === "onDynamicConversationFrame") {
              framesListenId = id;
              // Push matching frame
              ws.send(
                encodeRpcMessage([MSG.EventFire, id], {
                  topic: "conversation/daemon-sess-99",
                  update: "token",
                }),
              );
              // Push non-matching frame (should be ignored by filter)
              ws.send(
                encodeRpcMessage([MSG.EventFire, id], {
                  topic: "conversation/other-sess",
                  update: "ignored",
                }),
              );
            } else if (eventName === "onDynamicSessionLifecycle") {
              // Push matching lifecycle
              ws.send(
                encodeRpcMessage([MSG.EventFire, id], {
                  sessionId: "daemon-sess-99",
                  state: "idle",
                }),
              );
              // Push non-matching lifecycle (should be ignored)
              ws.send(
                encodeRpcMessage([MSG.EventFire, id], {
                  sessionId: "other-sess",
                  state: "busy",
                }),
              );
            }
          }
        },
      },
    });

    const mockDaemon: Daemon["Service"] = {
      // connect is an Effect-valued property (lazy-effect fix), not a method.
      connect: Effect.succeed({
        status: { host: "localhost", port: server.port ?? 12345, state: "ready", version: "3.18.2", pid: 123 },
        token: "daemon-token",
        wsPath: "/ws/host",
      }),
      // the watchdog reads this on every channel dispatch — same daemon as
      // `connect` so the memoized connection stays valid
      readStatus: Effect.succeed({
        host: "localhost",
        port: server.port ?? 12345,
        state: "ready",
        version: "3.18.2",
        pid: 123,
      }),
      getCapability: () => Effect.succeed("mock-cap-token"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;
      const session = yield* factory.create("/test/workspace", {
        onConversationFrame: (frame) =>
          Effect.sync(() => {
            framesReceived.push(frame);
            Deferred.doneUnsafe(frameDone, Effect.void);
          }),
        onChildFrame: (childId, frame) =>
          Effect.sync(() => {
            childFramesReceived.push({ childId, frame });
            Deferred.doneUnsafe(childFrameDone, Effect.void);
          }),
        onLifecycle: (lc) =>
          Effect.sync(() => {
            lifecyclesReceived.push(lc);
            Deferred.doneUnsafe(lifecycleDone, Effect.void);
          }),
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });

      // 1. Calling prompt or mode before createSession fails
      const errPre = yield* Effect.flip(session.sendPrompt("hello"));
      expect(errPre._tag).toBe("SessionError");
      expect(errPre.message).toContain("call createSession first");

      // 2. createSession
      const created = yield* session.createSession({ providerId: "zai", modelId: "glm-5" });
      expect(created.daemonSessionId).toBe("daemon-sess-99");
      expect(created.currentMode).toBe("plan");
      expect(created.currentModel).toBe("zai/glm-5");
      expect(created.models.length).toBe(1);
      expect(created.models[0]?.modelId).toBe("glm-5");
      expect(created.slashCommands?.length).toBe(1);
      expect(created.slashCommands?.[0]?.name).toBe("reset");
      expect(created.skills?.length).toBe(1);
      expect(created.skills?.[0]?.name).toBe("test-skill");

      // Wait for conversation frame and lifecycle events to be processed
      yield* Deferred.await(frameDone);
      yield* Deferred.await(lifecycleDone);

      expect(framesReceived.length).toBe(1);
      expect((framesReceived[0] as any).update).toBe("token");

      expect(lifecyclesReceived.length).toBe(1);
      expect((lifecyclesReceived[0] as any).state).toBe("idle");

      // 2b. subscribeChild → child-topic frames routed to onChildFrame;
      // frames of never-subscribed sessions stay dropped.
      yield* session.subscribeChild("child-sess-1");
      yield* Deferred.await(childFrameDone);
      expect(childFramesReceived.length).toBe(1);
      expect(childFramesReceived[0]?.childId).toBe("child-sess-1");
      expect((childFramesReceived[0]?.frame as any)?.update).toBe("child-token");
      // idempotent: a second subscribe for the same child makes no extra RPC
      const callsBefore = serverCalls.filter((c) => c.method === "subscribeConversationV4").length;
      yield* session.subscribeChild("child-sess-1");
      expect(serverCalls.filter((c) => c.method === "subscribeConversationV4").length).toBe(callsBefore);

      // 2c. listSubagents decodes the snapshot tolerantly (bad entry dropped)
      const snapshot = yield* session.listSubagents(20);
      expect(snapshot.revision).toBe(7);
      expect(snapshot.running.length).toBe(1);
      expect(snapshot.running[0]?.childSessionId).toBe("child-sess-1");
      expect(snapshot.running[0]?.toolCallId).toBe("agent-tc-1");
      expect(snapshot.ended.total).toBe(2);
      expect(snapshot.ended.items[0]?.title).toBe("Done");

      // 3. sendPrompt with model and attachments
      const promptRes = yield* session.sendPrompt(
        "Generate tests",
        { providerId: "zai", modelId: "glm-5", options: { reasoningLevel: "max" } },
        [{ kind: "file", filename: "test.ts", mimeType: "text/plain" }],
      );
      expect(typeof promptRes.inputId).toBe("string");

      // 4. setMode
      yield* session.setMode("code");

      // 5. resolveInteraction
      const resolveRes = yield* session.resolveInteraction("inter-1", { choice: "yes" });
      expect(resolveRes).toEqual({ commandResult: "done" });

      // 6. sendCommand
      const cmdRes = yield* session.sendCommand("customCommand", { foo: "bar" }, "exec-1");
      expect(cmdRes).toEqual({ commandResult: "done" });

      // 7. dispose — best-effort unsubscribe of the subscribed child first
      yield* session.dispose;
      expect(
        serverCalls.some(
          (c) => c.method === "unsubscribeConversationV4" && (c.arg as any)?.sessionId === "child-sess-1",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Log.layerQuiet),
      Effect.scoped,
    );

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("createSession error cases: saveProject failure and invalid createSession payload", async () => {
    let saveFails: boolean | string = false;
    let initFails = false;
    let createFails: boolean | string = false;
    let subFails = false;
    let skillsFails = false;

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
          const id = decoded.header[1] as number;
          const channel = decoded.header[2] as string;
          const method = decoded.header[3] as string;

          if (type === MSG.Promise) {
            if (channel === "project" && method === "saveProject") {
              if (saveFails === "reject") {
                ws.send(encodeRpcMessage([MSG.PromiseError, id, "save rejected"]));
              } else if (saveFails === true) {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {})); // missing project id
              } else {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], "proj-bare-id"));
              }
            } else if (channel === "zcode-agent" && method === "initialize") {
              if (initFails) {
                ws.send(encodeRpcMessage([MSG.PromiseError, id, "init rejected"]));
              } else {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {}));
              }
            } else if (channel === "zcode-session" && method === "createSession") {
              if (createFails === "throwShape") {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], "not-an-object"));
              } else if (createFails === true) {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {})); // missing sessionId
              } else {
                ws.send(
                  encodeRpcMessage([MSG.PromiseSuccess, id], {
                    sessionId: "s1",
                    settings: { model: { current: { ref: { modelId: "bare-model-id" } } } },
                  }),
                );
              }
            } else if (channel === "zcode-agent" && method === "subscribeConversationV4") {
              if (subFails) {
                ws.send(encodeRpcMessage([MSG.PromiseError, id, "sub rejected"]));
              } else {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {}));
              }
            } else if (channel === "skills" && method === "list") {
              if (skillsFails) {
                ws.send(encodeRpcMessage([MSG.PromiseError, id, "skills rejected"]));
              } else {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], []));
              }
            } else {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {}));
            }
          }
        },
      },
    });

    const mockDaemon: Daemon["Service"] = {
      // connect is an Effect-valued property (lazy-effect fix), not a method.
      connect: Effect.succeed({
        status: { host: "localhost", port: server.port ?? 12345, state: "ready", version: "3.18.2", pid: 123 },
        token: "tok",
        wsPath: "/ws/host",
      }),
      readStatus: Effect.succeed({
        host: "localhost",
        port: server.port ?? 12345,
        state: "ready",
        version: "3.18.2",
        pid: 123,
      }),
      getCapability: () => Effect.succeed("cap"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;

      // 1. saveProject fails to return id
      saveFails = true;
      const session1 = yield* factory.create("/ws1", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errSave = yield* Effect.flip(session1.createSession());
      expect(errSave._tag).toBe("SessionError");
      expect(errSave.message).toContain("cannot resolve a zcode server project");
      yield* session1.dispose;

      // 2. createSession fails to return sessionId
      saveFails = false;
      createFails = true;
      const session2 = yield* factory.create("/ws2", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errCreate = yield* Effect.flip(session2.createSession());
      expect(errCreate._tag).toBe("SessionError");
      expect(errCreate.message).toContain("createSession returned no sessionId");
      yield* session2.dispose;

      // 3. saveProject RPC rejected with error
      saveFails = "reject";
      createFails = false;
      const session3 = yield* factory.create("/ws3", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errSaveReject = yield* Effect.flip(session3.createSession());
      expect(errSaveReject._tag).toBe("SessionError");
      yield* session3.dispose;

      // 4. createSession returning malformed shape (throws in decodeCreateSessionShape)
      saveFails = false;
      createFails = "throwShape";
      const session4 = yield* factory.create("/ws4", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errCreateThrow = yield* Effect.flip(session4.createSession());
      expect(errCreateThrow._tag).toBe("SessionError");
      yield* session4.dispose;

      // 5. tolerated failures: initFails, subFails, skillsFails, and bare modelId
      saveFails = false;
      createFails = false;
      initFails = true;
      subFails = true;
      skillsFails = true;
      const session5 = yield* factory.create("/ws5", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const successRes = yield* session5.createSession();
      expect(successRes.daemonSessionId).toBe("s1");
      expect(successRes.currentModel).toBe("bare-model-id");
      yield* session5.dispose;
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Log.layerQuiet),
      Effect.scoped,
    );

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("dispose stays total when the app's onClosed handler fails", async () => {
    const warnings: string[] = [];

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
          if (decoded.header[0] !== MSG.Promise) return;
          const id = decoded.header[1] as number;
          const channel = decoded.header[2] as string;
          const method = decoded.header[3] as string;
          const body =
            channel === "project" && method === "saveProject"
              ? { project: { id: "p-1" } }
              : channel === "zcode-session" && method === "createSession"
                ? { sessionId: "sess-1" }
                : {};
          ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], body));
        },
      },
    });

    const mockDaemon: Daemon["Service"] = {
      connect: Effect.succeed({
        status: { host: "localhost", port: server.port ?? 12345, state: "ready", version: "3.18.2", pid: 1 },
        token: "tok",
        wsPath: "/ws/host",
      }),
      readStatus: Effect.succeed({
        host: "localhost",
        port: server.port ?? 12345,
        state: "ready",
        version: "3.18.2",
        pid: 1,
      }),
      getCapability: () => Effect.succeed("cap"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;
      const session = yield* factory.create("/test/workspace", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed({}),
        // The channel close surfaces this failure through `onClose`; dispose
        // must warn and still complete (never propagate it).
        onClosed: () => Effect.fail(new Error("onClose failed on purpose")),
      });
      yield* session.createSession();
      yield* session.dispose;
      expect(warnings.some((w) => w.includes("channel close failed during dispose"))).toBe(true);
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(
        Layer.succeed(
          Log,
          Log.of({
            debug: () => Effect.void,
            debugSync: () => undefined,
            warn: (...parts) => Effect.sync(() => void warnings.push(parts.map(String).join(" "))),
          }),
        ),
      ),
      Effect.scoped,
    );

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });
});

describe("ServeSession teardown edge", () => {
  test("dispose after the daemon socket died still runs the listener disposers' fallback", async () => {
    let closeServer: (() => void) | undefined;
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
          if (decoded.header[0] === MSG.Promise) {
            const id = decoded.header[1] as number;
            const channel = decoded.header[2] as string;
            const method = decoded.header[3] as string;
            const body =
              channel === "project" && method === "saveProject"
                ? { project: { id: "p-dump" } }
                : channel === "zcode-session" && method === "createSession"
                  ? { sessionId: "daemon-dump-1" }
                  : {};
            ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], body));
          }
        },
      },
    });
    closeServer = () => server.stop(true);

    const mockDaemon: Daemon["Service"] = {
      connect: Effect.succeed({
        status: { host: "localhost", port: server.port ?? 0, state: "ready" },
        token: "tok",
        wsPath: "/ws/host",
      }),
      readStatus: Effect.succeed({ host: "localhost", port: server.port ?? 0, state: "ready" }),
      getCapability: () => Effect.succeed("cap"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;
      const session = yield* factory.create("/dispose/ws", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      yield* session.createSession(); // subscribes — two listener disposers registered
      // Kill the socket out from under the channel, let the pump settle it.
      closeServer!();
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 150)));
      // Disposers now write into a settled channel → their writes fail and are
      // swallowed inside the disposer itself; dispose must still complete.
      yield* session.dispose;
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Log.layerQuiet),
      Effect.scoped,
    );

    await Effect.runPromise(prog);
  });

  test("listSubagents fails with SessionError on malformed RPC response, and subscribeChild handles in-flight unsubscribe", async () => {
    const listSubagentsResponse: any = "not an object";
    const serverCalls: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(encodeRpcMessage([MSG.Initialize]));
        },
        message(ws, msg) {
          const raw = typeof msg === "string" ? Buffer.from(msg) : new Uint8Array(msg);
          const decoded = decodeRpcMessage(raw);
          const type = decoded.header[0];
          const id = decoded.header[1] as number;
          if (type === MSG.Promise) {
            const channel = decoded.header[2] as string;
            const method = decoded.header[3] as string;
            serverCalls.push(method);
            if (channel === "project" && method === "saveProject") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { project: { id: "p-42" } }));
            } else if (channel === "zcode-agent" && method === "initialize") {
              ws.send(
                encodeRpcMessage([MSG.PromiseSuccess, id], {
                  workspace: { workspacePath: "/test", workspaceIdentity: "id" },
                }),
              );
            } else if (channel === "zcode-session" && method === "createSession") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { sessionId: "sess-123" }));
            } else if (channel === "zcode-agent" && method === "subscribeConversationV4") {
              setTimeout(() => {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { subscribed: true }));
              }, 15);
            } else if (channel === "zcode-agent" && method === "unsubscribeConversationV4") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { unsubscribed: true }));
            } else if (channel === "zcode-agent" && method === "listSessionSubagents") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], listSubagentsResponse));
            } else {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {}));
            }
          }
        },
      },
    });

    const mockDaemon: Daemon["Service"] = {
      connect: Effect.succeed({
        status: { host: "localhost", port: server.port ?? 0, state: "ready" },
        token: "tok",
        wsPath: "/ws",
      }),
      readStatus: Effect.succeed({ host: "localhost", port: server.port ?? 0, state: "ready" }),
      getCapability: () => Effect.succeed("cap"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;
      const session = yield* factory.create("/ws", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      yield* session.createSession();

      // Malformed listSubagents response
      const err = yield* Effect.flip(session.listSubagents(20));
      expect(err._tag).toBe("SessionError");

      // In-flight subscribe followed immediately by unsubscribe
      const fiber = yield* Effect.forkDetach(session.subscribeChild("child-race"));
      yield* Effect.yieldNow;
      yield* session.unsubscribeChild("child-race");
      yield* Fiber.join(fiber);
      expect(serverCalls).toContain("subscribeConversationV4");
      expect(serverCalls).toContain("unsubscribeConversationV4");

      yield* session.dispose;
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Log.layerQuiet),
      Effect.scoped,
    );

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });

  test("createSession formats and forwards mcpServers in createSession and resumeSession RPC payloads", async () => {
    const serverCalls: Array<{ channel: string; method: string; arg: unknown }> = [];
    let resumeCallCount = 0;

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
          const id = decoded.header[1] as number;
          const channel = decoded.header[2] as string;
          const method = decoded.header[3] as string;

          if (type === MSG.Promise) {
            const arg = (decoded.body as unknown[])?.[0];
            serverCalls.push({ channel, method, arg });

            if (channel === "project" && method === "saveProject") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { project: { id: "p-mcp" } }));
            } else if (channel === "zcode-agent" && method === "initialize") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { ok: true }));
            } else if (channel === "zcode-session" && method === "createSession") {
              ws.send(
                encodeRpcMessage([MSG.PromiseSuccess, id], {
                  sessionId: "daemon-sess-mcp-99",
                  session: { sessionId: "daemon-sess-mcp-99", mode: "plan" },
                  settings: {
                    model: {
                      current: { ref: { providerId: "zai", modelId: "glm-5" } },
                      available: [{ ref: { providerId: "zai", modelId: "glm-5" } }],
                    },
                  },
                }),
              );
            } else if (channel === "zcode-agent" && method === "subscribeConversationV4") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { subscribed: true }));
            } else if (channel === "skills" && method === "list") {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { skills: [] }));
            } else if (channel === "zcode-session" && method === "resumeSession") {
              resumeCallCount++;
              if (resumeCallCount === 1) {
                ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], { ok: true }));
              } else {
                ws.send(encodeRpcMessage([MSG.PromiseError, id], { message: "resumeSession failed" }));
              }
            } else {
              ws.send(encodeRpcMessage([MSG.PromiseSuccess, id], {}));
            }
          }
        },
      },
    });

    const mockDaemon: Daemon["Service"] = {
      connect: Effect.succeed({
        status: { host: "localhost", port: server.port ?? 0, state: "ready" },
        token: "tok",
        wsPath: "/ws",
      }),
      readStatus: Effect.succeed({ host: "localhost", port: server.port ?? 0, state: "ready" }),
      getCapability: () => Effect.succeed("cap"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;
      const session = yield* factory.create("/ws/mcp", {
        onConversationFrame: () => Effect.void,
        onChildFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });

      const mcpInput = [
        {
          type: "http" as const,
          name: "t3-code",
          url: "http://127.0.0.1:4000",
          headers: [{ name: "Authorization", value: "Bearer secret" }],
        },
        {
          type: "stdio" as const,
          name: "cli-srv",
          command: "/bin/srv",
          args: ["--opt"],
          env: [{ name: "KEY", value: "VAL" }],
        },
      ];

      yield* session.createSession(undefined, mcpInput);

      const createCall = serverCalls.find((c) => c.channel === "zcode-session" && c.method === "createSession");
      expect(createCall).toBeDefined();
      const createArg = createCall?.arg as { mcpServers?: unknown } | undefined;
      expect(createArg?.mcpServers).toEqual([
        {
          name: "t3-code",
          type: "http",
          url: "http://127.0.0.1:4000",
          headers: [{ name: "Authorization", value: "Bearer secret" }],
          isolation: "session",
          alwaysLoad: true,
        },
        {
          name: "cli-srv",
          command: "/bin/srv",
          args: ["--opt"],
          env: [{ name: "KEY", value: "VAL" }],
          isolation: "session",
          alwaysLoad: true,
        },
      ]);

      // Test setMcpServers sends resumeSession with updated mcpServers
      const updatedMcp = [
        {
          type: "http" as const,
          name: "t3-code-new",
          url: "http://127.0.0.1:4001",
        },
      ];
      yield* session.setMcpServers(updatedMcp);

      const resumeCall = serverCalls.find((c) => c.channel === "zcode-session" && c.method === "resumeSession");
      expect(resumeCall).toBeDefined();
      const resumeArg = resumeCall?.arg as { sessionId?: string; mcpServers?: unknown } | undefined;
      expect(resumeArg?.sessionId).toBe("daemon-sess-mcp-99");
      expect(resumeArg?.mcpServers).toEqual([
        {
          name: "t3-code-new",
          type: "http",
          url: "http://127.0.0.1:4001",
          headers: [],
          isolation: "session",
          alwaysLoad: true,
        },
      ]);

      // Calling setMcpServers again when daemon returns an error exercises the tolerate failure branch
      yield* session.setMcpServers(updatedMcp);

      // Calling setMcpServers with empty array clears servers
      yield* session.setMcpServers([]);
      const clearCall = serverCalls[serverCalls.length - 1];
      expect(clearCall?.channel).toBe("zcode-session");
      expect(clearCall?.method).toBe("resumeSession");
      const clearArg = clearCall?.arg as { sessionId?: string; mcpServers?: unknown } | undefined;
      expect(clearArg?.mcpServers).toEqual([]);

      yield* session.dispose;
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
      Effect.provide(Layer.succeed(BridgeExit, fakeBridgeExit)),
      Effect.provide(BunSocket.layerWebSocketConstructor),
      Effect.provide(Log.layerQuiet),
      Effect.scoped,
    );

    try {
      await Effect.runPromise(prog);
    } finally {
      server.stop(true);
    }
  });
});

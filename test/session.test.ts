import { describe, expect, test } from "bun:test";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Deferred, Effect, Layer } from "effect";
import { Log } from "../src/log.ts";
import { Daemon } from "../src/serve/daemon.ts";
import { ServeSessionFactory } from "../src/serve/session.ts";
import { decodeRpcMessage, encodeRpcMessage, MSG } from "../src/serve/wire.ts";

describe("ServeSession lifecycle and operations", () => {
  test("full session lifecycle: createSession, sendPrompt, setMode, resolveInteraction, sendCommand, frame filtering, and dispose", async () => {
    const framesReceived: any[] = [];
    const lifecyclesReceived: any[] = [];
    const serverCalls: Array<{ channel: string; method: string; arg: any }> = [];

    const frameDone = Deferred.makeUnsafe<void>();
    const lifecycleDone = Deferred.makeUnsafe<void>();

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
      connect: () =>
        Effect.succeed({
          status: { host: "localhost", port: server.port ?? 12345, state: "ready", version: "3.18.2", pid: 123 },
          token: "daemon-token",
          wsPath: "/ws/host",
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

      // 7. dispose
      yield* session.dispose();
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
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
      connect: () =>
        Effect.succeed({
          status: { host: "localhost", port: server.port ?? 12345, state: "ready", version: "3.18.2", pid: 123 },
          token: "tok",
          wsPath: "/ws/host",
        }),
      getCapability: () => Effect.succeed("cap"),
    };

    const prog = Effect.gen(function* () {
      const factory = yield* ServeSessionFactory;

      // 1. saveProject fails to return id
      saveFails = true;
      const session1 = yield* factory.create("/ws1", {
        onConversationFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errSave = yield* Effect.flip(session1.createSession());
      expect(errSave._tag).toBe("SessionError");
      expect(errSave.message).toContain("cannot resolve a zcode server project");
      yield* session1.dispose();

      // 2. createSession fails to return sessionId
      saveFails = false;
      createFails = true;
      const session2 = yield* factory.create("/ws2", {
        onConversationFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errCreate = yield* Effect.flip(session2.createSession());
      expect(errCreate._tag).toBe("SessionError");
      expect(errCreate.message).toContain("createSession returned no sessionId");
      yield* session2.dispose();

      // 3. saveProject RPC rejected with error
      saveFails = "reject";
      createFails = false;
      const session3 = yield* factory.create("/ws3", {
        onConversationFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errSaveReject = yield* Effect.flip(session3.createSession());
      expect(errSaveReject._tag).toBe("SessionError");
      yield* session3.dispose();

      // 4. createSession returning malformed shape (throws in decodeCreateSessionShape)
      saveFails = false;
      createFails = "throwShape";
      const session4 = yield* factory.create("/ws4", {
        onConversationFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const errCreateThrow = yield* Effect.flip(session4.createSession());
      expect(errCreateThrow._tag).toBe("SessionError");
      yield* session4.dispose();

      // 5. tolerated failures: initFails, subFails, skillsFails, and bare modelId
      saveFails = false;
      createFails = false;
      initFails = true;
      subFails = true;
      skillsFails = true;
      const session5 = yield* factory.create("/ws5", {
        onConversationFrame: () => Effect.void,
        onLifecycle: () => Effect.void,
        onRequest: () => Effect.succeed(undefined),
        onClosed: () => Effect.void,
      });
      const successRes = yield* session5.createSession();
      expect(successRes.daemonSessionId).toBe("s1");
      expect(successRes.currentModel).toBe("bare-model-id");
      yield* session5.dispose();
    }).pipe(
      Effect.provide(ServeSessionFactory.layerNoDeps),
      Effect.provide(Layer.succeed(Daemon, mockDaemon)),
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

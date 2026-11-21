import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { FileSystem } from "effect/FileSystem";
import { AcpServer, type AcpServerDeps } from "../src/acp/server.ts";
import { Log } from "../src/log.ts";
import { ServeSessionFactory, type ServeSession } from "../src/serve/session.ts";

/**
 * Edge-branch coverage for the ACP server that the main handler tests don't
 * reach: the quiet window lifecycle, frame dump, usage passthrough, interaction
 * failure fallbacks, config-option fallbacks, and the 180s guard timeout
 * (injected short via turnTimeoutMs).
 */

interface CapturedLog {
  debugCalls: string[];
  warnCalls: string[];
  /** die on a debug message containing this substring (defect-escape test) */
  dieOnDebug?: string;
}

const captureLog = (capture: CapturedLog): Log["Service"] => {
  const debugSync = (...parts: readonly unknown[]): void => {
    const line = parts.map(String).join(" ");
    capture.debugCalls.push(line);
    if (capture.dieOnDebug !== undefined && line.includes(capture.dieOnDebug)) {
      throw new Error("log exploded");
    }
  };
  return {
    debugSync,
    debug: (...parts) => Effect.sync(() => debugSync(...parts)),
    warn: (...parts) =>
      Effect.sync(() => {
        capture.warnCalls.push(parts.map(String).join(" "));
      }),
  };
};

interface ServerFixture {
  server: ReturnType<typeof AcpServer.make>;
  capture: CapturedLog;
  handlers: () => Record<string, (...args: never[]) => unknown>;
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  clientRequests: Array<{ method: string; params: unknown }>;
  sentPrompts: Array<{ text: string; modelSelection: unknown; attachments: unknown }>;
  resolveResults: Array<{ id: string; resolve: unknown }>;
  /** swap the clientRequest answer between calls ("FAIL" makes it fail) */
  setClientAnswer: (answer: unknown) => void;
  /** make resolveInteraction fail on the serve session */
  failResolve: boolean;
}

interface SessionScript {
  models?: unknown[];
  currentModel?: string;
  raw?: unknown;
  skills?: Array<{ name: string; description?: string; path?: string }>;
  /** clientRequest behaviour, swap between calls */
  clientAnswer?: unknown;
}

const makeFixture = (script: SessionScript = {}, depsOverride: Partial<AcpServerDeps> = {}): ServerFixture => {
  const capture: CapturedLog = { debugCalls: [], warnCalls: [] };
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const clientRequests: Array<{ method: string; params: unknown }> = [];
  const sentPrompts: Array<{ text: string; modelSelection: unknown; attachments: unknown }> = [];
  const resolveResults: Array<{ id: string; resolve: unknown }> = [];
  let clientAnswerValue: unknown = script.clientAnswer;
  let failResolve = false;

  let capturedHandlers: Record<string, (...args: never[]) => unknown> | undefined;

  const serveSession: ServeSession = {
    createSession: () =>
      Effect.succeed({
        models: (script.models ?? []) as never,
        currentModel: script.currentModel,
        skills: script.skills,
        raw: script.raw,
      }) as never,
    sendPrompt: (text, modelSelection, attachments) =>
      Effect.sync(() => {
        sentPrompts.push({ text, modelSelection, attachments });
        return { inputId: "inp-edge" };
      }) as never,
    resolveInteraction: (id, resolve) =>
      failResolve
        ? (Effect.fail(new Error("resolve rejected")) as never)
        : (Effect.sync(() => {
            resolveResults.push({ id, resolve });
            return { resolved: true };
          }) as never),
    setMode: () => Effect.void,
    setMcpServers: () => Effect.void,
    sendCommand: () => Effect.succeed({}),
    listSubagents: () => Effect.succeed({ revision: 0, running: [], ended: { total: 0, items: [] } }),
    subscribeChild: () => Effect.void,
    unsubscribeChild: () => Effect.void,
    dispose: Effect.void,
  } as ServeSession;

  const server = AcpServer.make({
    sessions: {
      create: (_cwd: string, handlers: never) => {
        capturedHandlers = handlers as never;
        return Effect.succeed(serveSession);
      },
    } as unknown as ServeSessionFactory["Service"],
    log: captureLog(capture),
    emitNotification: (method, params) =>
      Effect.sync(() => {
        notifications.push({ method, params: params as Record<string, unknown> });
      }),
    clientRequest: (method, params) => {
      clientRequests.push({ method, params });
      if (clientAnswerValue === "FAIL") return Effect.fail(new Error("client refused")) as never;
      return Effect.succeed(clientAnswerValue ?? {}) as never;
    },
    fallbackModels: Effect.succeed((script.models ?? []) as never),
    ...depsOverride,
  });

  return {
    server,
    capture,
    handlers: () => {
      if (capturedHandlers === undefined) throw new Error("session not created yet");
      return capturedHandlers;
    },
    notifications,
    clientRequests,
    sentPrompts,
    resolveResults,
    setClientAnswer: (answer: unknown) => {
      clientAnswerValue = answer;
    },
    get failResolve() {
      return failResolve;
    },
    set failResolve(v: boolean) {
      failResolve = v;
    },
  };
};

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const settleFrame = (handlers: Record<string, (...args: never[]) => unknown>, rowId = 0): Promise<unknown> =>
  Effect.runPromise(
    (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: { rowId, kind: "turnHeader", state: "completedSuccess" } }],
      },
    }),
  );

const assistantFrame = (handlers: Record<string, (...args: never[]) => unknown>, rowId: number): Promise<unknown> =>
  Effect.runPromise(
    (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: { rowId, kind: "assistantText", text: "chunk", state: "complete" } }],
      },
    }),
  );

const promptFiber = (
  fixture: ServerFixture,
  sessionId: string,
  text = "hello",
): Promise<Fiber.Fiber<unknown, unknown>> =>
  Effect.runPromise(
    Effect.forkDetach(fixture.server.handle("session/prompt", { sessionId, prompt: text })) as never,
  ) as never;

const joinStopReason = async (fiber: Fiber.Fiber<unknown, unknown>): Promise<string> =>
  ((await Effect.runPromise(Fiber.join(fiber) as never)) as { stopReason: string }).stopReason;

describe("AcpServer edge branches", () => {
  test("assistantSettled arms the quiet window; quiet fibers interrupt on clearQuiet and endTurn", async () => {
    const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "q-edge" }));
    const handlers = fx.handlers();

    // A: complete normally — turn state released, translator goes idle.
    const fiberA = await promptFiber(fx, "q-edge", "A");
    await wait(15);
    await settleFrame(handlers, 0);
    expect(await joinStopReason(fiberA)).toBe("end_turn");

    // Idle: assistant rows settle with no active work → quiet window arms.
    await assistantFrame(handlers, 5);
    await wait(15);
    // Settling again re-arms → clearQuiet interrupts the armed fiber.
    await assistantFrame(handlers, 6);
    await wait(15);

    // B: a row update while the turn is running clears the quiet fiber,
    // then completion ends the turn.
    const fiberB = await promptFiber(fx, "q-edge", "B");
    await wait(15);
    await assistantFrame(handlers, 7);
    await settleFrame(handlers, 0);
    expect(await joinStopReason(fiberB)).toBe("end_turn");

    // Idle: complete row arms the window, then a non-settled streaming chunk
    // (updates>0, no active work, not settled) clears it via the updates arm.
    await assistantFrame(handlers, 9);
    await Effect.runPromise(
      (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            { op: "row.upserted", row: { rowId: 9, kind: "assistantText", text: "partial", state: "streaming" } },
          ],
        },
      }),
    );
    await wait(15);

    // Idle arm, then the NEXT turn's completion interrupts the still-armed quiet
    // fiber inside endTurn/stopFibers. Unknown row kind + unknown op first,
    // so the endTurn debug line renders non-empty unknown summaries.
    await assistantFrame(handlers, 10);
    await wait(15);
    await Effect.runPromise(
      (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            { op: "row.appended", row: { rowId: 77, kind: "mysteryWidget", text: "x" } },
            { op: "mysteryOp", target: { rowId: 78 } },
          ],
        },
      }),
    );
    const fiberC = await promptFiber(fx, "q-edge", "C");
    await wait(15);
    await settleFrame(handlers, 0);
    expect(await joinStopReason(fiberC)).toBe("end_turn");
    expect(fx.capture.debugCalls.some((l) => l.includes("ops=mysteryOp×1"))).toBe(true);
    expect(fx.capture.debugCalls.some((l) => l.includes("kinds=mysteryWidget×1"))).toBe(true);
  });

  test("usage in a frame is remembered and attached to the prompt result", async () => {
    const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "usage-sess" }));
    const handlers = fx.handlers();

    const fiber = await promptFiber(fx, "usage-sess");
    await wait(15);
    await Effect.runPromise(
      (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                usage: {
                  contextWindow: { usedTokens: 7, maxTokens: 1000 },
                  cumulative: { inputTokens: 7, outputTokens: 3 },
                },
              },
            },
          ],
        },
      }),
    );
    await settleFrame(handlers, 0);

    const result = (await Effect.runPromise(Fiber.join(fiber) as never)) as {
      stopReason: string;
      usage?: { totalTokens: number };
    };
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.totalTokens).toBe(10);
  });

  test("onClosed after a daemon update ends the turn with end_turn", async () => {
    const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "closed-sess" }));
    const handlers = fx.handlers();

    const fiber = await promptFiber(fx, "closed-sess");
    await wait(15);
    await assistantFrame(handlers, 3); // marks sawUpdate
    await Effect.runPromise((handlers.onClosed as (r: string) => Effect.Effect<void, unknown>)("socket died"));
    expect(await joinStopReason(fiber)).toBe("end_turn");
  });

  test("server-request permission without interactionId answers bare options (both fallbacks)", async () => {
    const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "reqperm-sess" }));
    const handlers = fx.handlers();
    const onRequest = handlers.onRequest as (c: string, n: string, a: unknown) => Effect.Effect<unknown, unknown>;

    // 1. client answered → bare answer object (no interactionId echoed back)
    fx.setClientAnswer({ outcome: { outcome: "selected", optionId: "opt-a" } });
    const answered = await Effect.runPromise(
      onRequest("zcode", "requestPermission", {
        toolName: "run_command",
        options: [{ optionId: "opt-a", kind: "allow" }],
      }),
    );
    expect(answered).toEqual({ answer: { optionId: "opt-a", kind: "allow" } });

    // 2. client request failed → first raw option echoed as the fallback
    fx.setClientAnswer("FAIL");
    const fallback = await Effect.runPromise(
      onRequest("zcode", "requestPermission", {
        toolName: "run_command",
        options: [{ optionId: "opt-a", kind: "allow" }],
      }),
    );
    expect(fallback).toEqual({ answer: { optionId: "opt-a", kind: "allow" } });
  });

  test("elicitation fallbacks: failed cancel fallback and failed resolution are logged, not thrown", async () => {
    // 1. clientRequest fails AND the fallback cancel resolution fails
    const failingResolve = makeFixture({ models: [{ providerId: "p", modelId: "m" }] });
    failingResolve.setClientAnswer("FAIL");
    failingResolve.failResolve = true;
    await Effect.runPromise(failingResolve.server.handle("session/new", { sessionId: "el-1" }));
    const h1 = failingResolve.handlers();
    const fiber1 = await promptFiber(failingResolve, "el-1");
    await wait(15);
    await Effect.runPromise(
      (h1.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                pendingInteractions: [{ interactionId: "el-x", kind: "userInput", payload: { prompt: "Confirm?" } }],
              },
            },
          ],
        },
      }),
    );
    await wait(30);
    await settleFrame(h1);
    await joinStopReason(fiber1);
    expect(failingResolve.capture.debugCalls.some((l) => l.includes("fallback cancel resolution failed"))).toBe(true);

    // 2. client answered but resolveInteraction itself fails
    const resolveFails = makeFixture({
      models: [{ providerId: "p", modelId: "m" }],
      clientAnswer: { action: "accept", content: { q0: "yes" } },
    });
    resolveFails.failResolve = true;
    await Effect.runPromise(resolveFails.server.handle("session/new", { sessionId: "el-2" }));
    const h2 = resolveFails.handlers();
    const fiber2 = await promptFiber(resolveFails, "el-2");
    await wait(15);
    await Effect.runPromise(
      (h2.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                pendingInteractions: [{ interactionId: "el-y", kind: "userInput", payload: { prompt: "Confirm?" } }],
              },
            },
          ],
        },
      }),
    );
    await wait(30);
    await settleFrame(h2);
    await joinStopReason(fiber2);
    expect(resolveFails.capture.debugCalls.some((l) => l.includes("resolveInteraction failed"))).toBe(true);
  });

  test("permission fallbacks: failed fallback option and failed resolution are logged, not thrown", async () => {
    const opts = [{ optionId: "allow_opt", kind: "allow", label: "Allow" }];
    const feed = (h: Record<string, (...args: never[]) => unknown>) =>
      Effect.runPromise(
        (h.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
          payload: {
            kind: "deltas",
            deltas: [
              {
                op: "state.updated",
                patch: {
                  pendingInteractions: [
                    {
                      interactionId: "perm-z",
                      kind: "permission",
                      payload: { toolName: "run_command", options: opts },
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

    // 1. clientRequest fails AND the fallback resolution fails
    const fx1 = makeFixture({ models: [{ providerId: "p", modelId: "m" }] });
    fx1.setClientAnswer("FAIL");
    fx1.failResolve = true;
    await Effect.runPromise(fx1.server.handle("session/new", { sessionId: "pm-1" }));
    const fiber1 = await promptFiber(fx1, "pm-1");
    await wait(15);
    await feed(fx1.handlers());
    await wait(30);
    await settleFrame(fx1.handlers());
    await joinStopReason(fiber1);
    expect(fx1.capture.debugCalls.some((l) => l.includes("fallback resolution failed"))).toBe(true);

    // 2. client answered but resolveInteraction fails
    const fx2 = makeFixture({
      models: [{ providerId: "p", modelId: "m" }],
      clientAnswer: { outcome: { outcome: "selected", optionId: "allow_opt" } },
    });
    fx2.failResolve = true;
    await Effect.runPromise(fx2.server.handle("session/new", { sessionId: "pm-2" }));
    const fiber2 = await promptFiber(fx2, "pm-2");
    await wait(15);
    await feed(fx2.handlers());
    await wait(30);
    await settleFrame(fx2.handlers());
    await joinStopReason(fiber2);
    expect(fx2.capture.debugCalls.some((l) => l.includes("resolveInteraction failed"))).toBe(true);
  });

  test("a defect escaping an interaction fallback is caught by the fork wrapper and warned", async () => {
    const capture: CapturedLog = {
      debugCalls: [],
      warnCalls: [],
      dieOnDebug: "elicitation/create threw",
    };
    let handlers: Record<string, (...args: never[]) => unknown> | undefined;
    const server = AcpServer.make({
      sessions: {
        create: (_cwd: string, h: never) => {
          handlers = h as never;
          return Effect.succeed({
            createSession: () => Effect.succeed({ models: [], skills: [], raw: undefined }) as never,
            sendPrompt: () => Effect.succeed({ inputId: "i" }) as never,
            resolveInteraction: () => Effect.succeed({}) as never,
            setMode: () => Effect.void,
            sendCommand: () => Effect.succeed({}),
            dispose: Effect.void,
          }) as never;
        },
      } as unknown as ServeSessionFactory["Service"],
      log: captureLog(capture),
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.fail(new Error("client gone")) as never,
      fallbackModels: Effect.succeed([]),
    });

    await Effect.runPromise(server.handle("session/new", { sessionId: "defect-sess" }));
    const fiber = await promptFiber({ server } as never, "defect-sess");
    await wait(15);
    await Effect.runPromise(
      (handlers!.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                pendingInteractions: [{ interactionId: "el-d", kind: "userInput", payload: { prompt: "?" } }],
              },
            },
          ],
        },
      }),
    );
    await wait(30);
    await Effect.runPromise(
      (handlers!.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" } }],
        },
      }),
    );
    await joinStopReason(fiber);
    expect(capture.warnCalls.some((l) => l.includes("[interaction] failed"))).toBe(true);
    expect(capture.warnCalls.some((l) => l.includes("log exploded"))).toBe(true);
  });

  test("frame dump happens once when ZCODE_SERVE_ACP_DUMP=1 at construction", async () => {
    const originalDump = process.env.ZCODE_SERVE_ACP_DUMP;
    const originalDebug = process.env.ZCODE_SERVE_ACP_DEBUG;
    process.env.ZCODE_SERVE_ACP_DUMP = "1";
    process.env.ZCODE_SERVE_ACP_DEBUG = "1"; // translator log adapter wakes up too
    try {
      const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] });
      await Effect.runPromise(fx.server.handle("session/new", { sessionId: "dump-sess" }));
      const handlers = fx.handlers();
      await assistantFrame(handlers, 1);
      await assistantFrame(handlers, 2);
      await Effect.runPromise(
        (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
          payload: {
            kind: "deltas",
            deltas: [{ op: "row.appended", row: { rowId: 66, kind: "mysteryDumpRow", text: "x" } }],
          },
        }),
      );
      const dumps = fx.capture.debugCalls.filter((l) => l.includes("[dump] first frame"));
      expect(dumps.length).toBe(1);
      expect(fx.capture.debugCalls.some((l) => l.includes("unknown row kind=mysteryDumpRow"))).toBe(true);
    } finally {
      if (originalDump !== undefined) process.env.ZCODE_SERVE_ACP_DUMP = originalDump;
      else delete process.env.ZCODE_SERVE_ACP_DUMP;
      if (originalDebug !== undefined) process.env.ZCODE_SERVE_ACP_DEBUG = originalDebug;
      else delete process.env.ZCODE_SERVE_ACP_DEBUG;
    }
  });

  test("thoughtLevel falls back to reasoningLevels[0] then to 'max'", async () => {
    // 1. model with levels but no default → first level
    const withLevels = makeFixture({
      models: [{ providerId: "p", modelId: "m", label: "M", reasoningLevels: [{ value: "high", label: "High" }] }],
    });
    await Effect.runPromise(withLevels.server.handle("session/new", { sessionId: "lvl-sess" }));
    const fiberL = await promptFiber(withLevels, "lvl-sess");
    await wait(15);
    await settleFrame(withLevels.handlers());
    await joinStopReason(fiberL);
    const selL = withLevels.sentPrompts[0]?.modelSelection as { options?: { reasoningLevel?: string } };
    expect(selL?.options?.reasoningLevel).toBe("high");

    // 2. bare model → 'max'
    const bare = makeFixture({ models: [{ providerId: "p", modelId: "m2", label: "M2" }] });
    await Effect.runPromise(bare.server.handle("session/new", { sessionId: "bare-sess" }));
    const fiberB = await promptFiber(bare, "bare-sess");
    await wait(15);
    await settleFrame(bare.handlers());
    await joinStopReason(fiberB);
    const selB = bare.sentPrompts[0]?.modelSelection as { options?: { reasoningLevel?: string } };
    expect(selB?.options?.reasoningLevel).toBe("max");
  });

  test("projection in the createSession result seeds the initial usage window", async () => {
    const fx = makeFixture({
      models: [{ providerId: "p", modelId: "m", label: "M" }],
      raw: { projection: { contextUsed: 42, contextWindow: 8000 } },
    });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "proj-sess" }));
    const usage = fx.notifications.find(
      (n) => (n.params.update as Record<string, unknown> | undefined)?.sessionUpdate === "usage_update",
    );
    const update = usage?.params.update as Record<string, unknown> | undefined;
    expect(update?.used).toBe(42);
    expect(update?.size).toBe(8000);
  });

  test("session/load on an existing bridge without model selection reloads it (no modelSelection)", async () => {
    // Daemon advertises nothing and the fallback finds nothing → bridge has no
    // modelSelection → session/load hits the modelsToAcp(models, undefined) arm
    // and prompts carry no modelSelection.
    const fx = makeFixture({ models: [] });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "nosel" }));

    const loaded = (await Effect.runPromise(
      fx.server.handle("session/load", { cwd: "/tmp/w", sessionId: "nosel" }),
    )) as { sessionId: string; models: { availableModels: unknown[] } };
    expect(loaded.sessionId).toBe("nosel");
    expect(loaded.models.availableModels).toEqual([]);

    const fiber = await promptFiber(fx, "nosel");
    await wait(15);
    await settleFrame(fx.handlers());
    await joinStopReason(fiber);
    expect(fx.sentPrompts[0]?.modelSelection).toBeUndefined();
  });

  test("fresh-bridge quiet window: idle updates clear it, the first turn's end interrupts it", async () => {
    // Row-based completions leave the translator's stale active-work counter
    // (only control-phase patches reset it), so a fresh bridge — before the
    // first startTurn — is the one state where hasActiveWork() is false.
    const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "fresh-q" }));
    const handlers = fx.handlers();
    const feed = (row: Record<string, unknown>) =>
      Effect.runPromise(
        (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
          payload: { kind: "deltas", deltas: [{ op: "row.upserted", row }] },
        }),
      );

    // Assistant settles on the fresh bridge → quiet window arms.
    await feed({ rowId: 1, kind: "assistantText", text: "a", state: "complete" });
    await wait(15);
    // A streaming chunk updates without settling → clears the armed window.
    await feed({ rowId: 2, kind: "assistantText", text: "b", state: "streaming" });
    await wait(15);
    // Settles again → re-arms.
    await feed({ rowId: 3, kind: "assistantText", text: "c", state: "complete" });
    await wait(15);

    // The first turn completes with no intervening frames → endTurn's
    // stopFibers interrupts the still-armed quiet fiber.
    const fiber = await promptFiber(fx, "fresh-q");
    await wait(15);
    await settleFrame(handlers, 0);
    expect(await joinStopReason(fiber)).toBe("end_turn");
  });

  test("the initial-response guard fails the turn when no frame arrives in time", async () => {
    const fx = makeFixture({ models: [{ providerId: "p", modelId: "m", label: "M" }] }, { turnTimeoutMs: 25 });
    await Effect.runPromise(fx.server.handle("session/new", { sessionId: "timeout-sess" }));
    const err = await Effect.runPromise(
      Effect.flip(fx.server.handle("session/prompt", { sessionId: "timeout-sess", prompt: "slow daemon" }) as never),
    );
    expect((err as { message: string }).message).toContain("Turn timed out");
    // The message reports the budget actually used, not a frozen 180s.
    expect((err as { message: string }).message).toContain("within 25ms");
  });

  test("layerNoDeps defaults: no-models fallback, host notifications, and unwired client requests", async () => {
    let capturedHandlers: Record<string, (...args: never[]) => unknown> | undefined;
    const sessions = {
      create: (_cwd: string, handlers: never) => {
        capturedHandlers = handlers as never;
        return Effect.succeed({
          createSession: () => Effect.succeed({ models: [], skills: [], raw: undefined }) as never,
          sendPrompt: () => Effect.succeed({ inputId: "i" }) as never,
          resolveInteraction: () => Effect.succeed({}) as never,
          setMode: () => Effect.void,
          sendCommand: () => Effect.succeed({}),
          dispose: Effect.void,
        }) as never;
      },
    } as unknown as ServeSessionFactory["Service"];

    const server = await Effect.runPromise(
      AcpServer.pipe(
        Effect.provide(AcpServer.layerNoDeps),
        Effect.provideService(ServeSessionFactory, sessions),
        Effect.provideService(Log, {
          debug: () => Effect.void,
          warn: () => Effect.void,
          debugSync: () => {},
        }),
        Effect.provideService(FileSystem, {
          readFileString: () => Effect.fail(new Error("ENOENT")),
        } as unknown as FileSystem),
      ),
    );

    // Daemon advertises no models and the R-closed fallback finds nothing
    // (the FileSystem fake fails its reads) — session/new still answers.
    await Effect.runPromise(server.handle("session/new", { sessionId: "ld-sess" }));
    const handlers = capturedHandlers!;

    // An interaction hits the unwired default clientRequest → its
    // ClientRequestError failure is tolerated into the fallback resolution.
    await Effect.runPromise(
      (handlers.onConversationFrame as (p: unknown) => Effect.Effect<void, unknown>)({
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                pendingInteractions: [{ interactionId: "ld-el", kind: "userInput", payload: { prompt: "?" } }],
              },
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    // ...and a normal turn still completes through the same defaults.
    const fiber = await promptFiber({ server } as never, "ld-sess");
    await new Promise((r) => setTimeout(r, 15));
    await settleFrame(handlers);
    expect(await joinStopReason(fiber)).toBe("end_turn");
  });
});

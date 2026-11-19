/**
 * ACP server (Agent Client Protocol, newline-delimited JSON-RPC over stdio).
 *
 * Surface (drop-in contract): initialize · auth/authenticate · session/new ·
 * session/load · session/resume · session/prompt · session/set_model ·
 * session/set_config_option · session/set_mode · session/cancel ·
 * session/unload (new — prunes the session registry, the pre-rewrite leak).
 *
 * The pre-rewrite deferred-promise/timer bookkeeping (pendingTurn +
 * quietTimer + initial-response timer + endTurn/failTurn near-duplicates) is
 * now one `TurnState` in a Ref: a Deferred the prompt awaits, a sawUpdate
 * flag feeding the 180s initial-response guard, and a quiet-window fiber —
 * interrupt on take, exactly the old clear-timers-then-resolve order.
 */
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { DiscoveredSkill } from "../serve/session.ts";
import { envDump } from "../config.ts";
import {
  ServeSessionFactory,
  type AvailableModel,
  type PromptAttachment,
  type ServeSession,
} from "../serve/session.ts";
import { AcpMethodError, ClientRequestError, renderError, tolerate } from "../errors.ts";
import { Log } from "../log.ts";
import { fallbackModels, modelsToAcp } from "../models.ts";
import {
  buildConfigOptions,
  buildInitializeResult,
  buildAvailableCommands,
  decodePrompt,
  rewriteSkillMention,
  type ModelSelection,
} from "./protocol.ts";
import {
  buildElicitationParams,
  buildElicitationResolve,
  buildPermissionParams,
  extractElicitationQuestions,
  extractPermissionOptionId,
  isElicitation,
  mapPermissionOptions,
  readPermissionServerRequest,
} from "./interactions.ts";
import { FrameTranslator, type PendingInteraction, type TurnUsage } from "../translate/translator.ts";

interface BridgeSession {
  readonly id: string;
  serve: ServeSession;
  readonly translator: FrameTranslator;
  models: AvailableModel[];
  skills: DiscoveredSkill[];
  modelSelection?: ModelSelection;
  thoughtLevel?: string;
  currentMode?: string;
  lastUsage?: TurnUsage;
  readonly handledInteractions: Set<string>;
  readonly turn: Ref.Ref<Option.Option<TurnState>>;
  readonly quietFiber: Ref.Ref<Option.Option<Fiber.Fiber<void, unknown>>>;
  readonly dumpRef: Ref.Ref<boolean>;
}

interface TurnState {
  readonly deferred: Deferred.Deferred<string, AcpMethodError>;
  sawUpdate: boolean;
  initialGuard?: Fiber.Fiber<void, unknown>;
}

const DUMP_FRAMES = envDump();

export interface AcpServerDeps {
  readonly sessions: ServeSessionFactory["Service"];
  readonly log: Log["Service"];
  readonly emitNotification: (method: string, params: unknown) => Effect.Effect<void, unknown>;
  /** request TO the ACP client (elicitation/create, session/request_permission) */
  readonly clientRequest: (method: string, params: unknown) => Effect.Effect<unknown, unknown>;
  /** R-closed fallback model discovery (daemon advertised none) */
  readonly fallbackModels: Effect.Effect<AvailableModel[]>;
}

export class AcpServer extends Context.Service<
  AcpServer,
  {
    handle(method: string, params: Record<string, unknown>): Effect.Effect<unknown, AcpMethodError>;
  }
>()("zcode-serve-acp/AcpServer") {
  /** Direct construction for tests — same wiring bin.ts gets from the layer. */
  static readonly make = (deps: AcpServerDeps): AcpServer["Service"] => makeServer(deps);

  static readonly layerNoDeps: Layer.Layer<AcpServer, never, ServeSessionFactory | Log | FileSystem> = Layer.effect(
    AcpServer,
    Effect.gen(function* () {
      const sessions = yield* ServeSessionFactory;
      const log = yield* Log;
      const fs = yield* FileSystem;
      return AcpServer.make({
        sessions,
        log,
        emitNotification: () => Effect.void, // replaced by the host at runtime
        clientRequest: () => Effect.fail(new ClientRequestError({ message: "client request channel not wired" })),
        fallbackModels: fallbackModels.pipe(Effect.provideService(FileSystem, fs)),
      });
    }),
  );
}

const makeServer = (deps: AcpServerDeps): AcpServer["Service"] => {
  const bridgeSessions = new Map<string, BridgeSession>();
  const { log, emitNotification, clientRequest } = deps;

  const getSession = (sessionId: string): Effect.Effect<BridgeSession, AcpMethodError> =>
    Effect.gen(function* () {
      const bridge = bridgeSessions.get(sessionId);
      if (bridge === undefined) {
        return yield* new AcpMethodError({ method: "session", message: `unknown session ${sessionId}` });
      }
      return bridge;
    });

  // ---- turn lifecycle ----

  const takeTurn = (bridge: BridgeSession): Effect.Effect<Option.Option<TurnState>> =>
    Ref.modify(bridge.turn, (current) => [current, Option.none()]);

  const stopFibers = (state: TurnState, bridge: BridgeSession): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const quiet = yield* Ref.getAndSet(bridge.quietFiber, Option.none());
      if (Option.isSome(quiet)) {
        yield* Fiber.interrupt(quiet.value).pipe(Effect.orElseSucceed(() => undefined));
      }
      if (state.initialGuard !== undefined) {
        yield* Fiber.interrupt(state.initialGuard).pipe(Effect.orElseSucceed(() => undefined));
      }
    });

  const endTurn = (bridge: BridgeSession, stopReason: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const taken = yield* takeTurn(bridge);
      if (Option.isNone(taken)) return;
      const state = taken.value;
      yield* stopFibers(state, bridge);
      yield* log.debug(`[acp] turn end (${stopReason}) — translator unknowns: ${bridge.translator.debugSummary()}`);
      Deferred.doneUnsafe(state.deferred, Effect.succeed(stopReason));
    });

  const failTurn = (bridge: BridgeSession, message: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const taken = yield* takeTurn(bridge);
      if (Option.isNone(taken)) return;
      const state = taken.value;
      yield* stopFibers(state, bridge);
      yield* log.debug(`[acp] failTurn: ${message}`);
      Deferred.doneUnsafe(state.deferred, Effect.fail(new AcpMethodError({ method: "session/prompt", message })));
    });

  const clearQuiet = (bridge: BridgeSession): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(bridge.quietFiber, Option.none());
      if (Option.isSome(current)) {
        yield* Fiber.interrupt(current.value).pipe(Effect.orElseSucceed(() => undefined));
      }
    });

  const armQuietWindow = (bridge: BridgeSession): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* clearQuiet(bridge);
      const quiet = yield* Effect.forkDetach(
        Effect.sleep("5 seconds").pipe(Effect.flatMap(() => endTurn(bridge, "assistant settled + quiet"))),
      );
      yield* Ref.set(bridge.quietFiber, Option.some(quiet));
    });

  // ---- frame / lifecycle / channel handlers ----

  const onConversationFrame =
    (bridge: BridgeSession) =>
    (payload: unknown): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        yield* log.debug(`[frame] in: ${JSON.stringify(payload).slice(0, 160)}`);
        if (DUMP_FRAMES) {
          const dumped = yield* Ref.get(bridge.dumpRef);
          if (!dumped) {
            yield* Ref.set(bridge.dumpRef, true);
            yield* deps.log.debug(`[dump] first frame: ${JSON.stringify(payload)}`);
          }
        }
        const result = bridge.translator.fold(payload);
        if (result.usage !== undefined) {
          bridge.lastUsage = result.usage;
        }
        const turnNow = yield* Ref.get(bridge.turn);
        if (Option.isSome(turnNow)) {
          turnNow.value.sawUpdate = true;
        }
        for (const update of result.updates) {
          yield* log.debug(`[frame] emit ${update.sessionUpdate}`);
          yield* emitNotification("session/update", { sessionId: bridge.id, update });
        }
        for (const interaction of result.pendingInteractions ?? []) {
          yield* Effect.forkDetach(
            tolerate(handlePendingInteraction(bridge, interaction), (cause) =>
              log.warn(`[interaction] failed: ${renderError(cause)}`),
            ),
          );
        }
        if (result.turnFailed) {
          yield* failTurn(bridge, result.errorMessage ?? "Turn execution failed in daemon");
          return;
        }
        if (result.turnCancelled === true) {
          yield* endTurn(bridge, "cancelled");
          return;
        }
        if (result.turnComplete) {
          yield* endTurn(bridge, "end_turn");
          return;
        }
        if (result.hasActiveWork) {
          yield* clearQuiet(bridge);
          return;
        }
        if (result.assistantSettled) {
          yield* armQuietWindow(bridge);
          return;
        }
        if (result.updates.length > 0) {
          yield* clearQuiet(bridge);
        }
      });

  const onLifecycle =
    (bridge: BridgeSession) =>
    (payload: unknown): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const raw = JSON.stringify(payload);
        yield* log.debug(`[lifecycle] ${raw.slice(0, 300)}`);
        const p = payload as { state?: string; lastError?: { message?: string; code?: string } | null; error?: string };
        if (p.state === "faulted" || p.lastError) {
          const msg = p.lastError?.message || p.error || "daemon session faulted";
          yield* failTurn(bridge, `Daemon error: ${msg}`);
          return;
        }
        if (p.state === "stopping" || p.state === "unloaded") {
          yield* endTurn(bridge, "end_turn");
        }
      });

  const onClosed =
    (bridge: BridgeSession) =>
    (reason: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const turnNow = yield* Ref.get(bridge.turn);
        if (Option.isSome(turnNow) && !turnNow.value.sawUpdate) {
          yield* failTurn(bridge, `Connection closed before response: ${reason}`);
        } else {
          yield* endTurn(bridge, "end_turn");
        }
      });

  const onRequest =
    (bridge: BridgeSession) =>
    (channelName: string, name: string, arg: unknown): Effect.Effect<unknown, unknown> =>
      Effect.gen(function* () {
        yield* log.debug(`[server-request] ${channelName}.${name}: ${JSON.stringify(arg)?.slice(0, 500)}`);
        if (name.toLowerCase().includes("permission")) {
          const rawArg = readPermissionServerRequest(arg);
          const rawOptions = rawArg.options ?? [];
          const mapped = mapPermissionOptions(rawOptions);
          const params = buildPermissionParams(
            bridge.id,
            { toolName: rawArg.toolName, options: rawOptions } as Record<string, unknown>,
            bridge.translator.getLatestActiveToolCallId(),
          );
          const answer = yield* tolerate(clientRequest("session/request_permission", params), (cause) =>
            log.debug(`[server-request] request_permission threw: ${renderError(cause)}`),
          );
          if (answer !== undefined) {
            const chosen = extractPermissionOptionId(
              answer as { outcome?: { outcome?: string; optionId?: string }; optionId?: string },
              rawOptions,
              mapped,
            );
            const daemonOption = rawOptions.find((o) => String(o.optionId ?? o.id) === chosen);
            return rawArg.interactionId !== undefined
              ? { interactionId: rawArg.interactionId, answer: daemonOption ?? { optionId: chosen } }
              : { answer: daemonOption ?? { optionId: chosen } };
          }
          const allowOpt = rawOptions[0];
          return rawArg.interactionId !== undefined
            ? { interactionId: rawArg.interactionId, answer: allowOpt ?? { optionId: "allow" } }
            : { answer: allowOpt ?? { optionId: "allow" } };
        }
        // Unknown server request — acknowledge with empty object (logged above).
        return {};
      });

  // ---- interactions ----

  const handlePendingInteraction = (
    bridge: BridgeSession,
    interaction: PendingInteraction,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (bridge.handledInteractions.has(interaction.interactionId)) return;
      bridge.handledInteractions.add(interaction.interactionId);
      yield* log.debug(`[interaction] pending interaction ${interaction.interactionId} (kind=${interaction.kind})`);
      const rawPayload = (interaction.payload ?? {}) as Record<string, unknown>;
      if (isElicitation(interaction)) {
        yield* runElicitation(bridge, interaction.interactionId, rawPayload);
      } else {
        yield* runPermission(bridge, interaction.interactionId, rawPayload);
      }
    });

  const runElicitation = (
    bridge: BridgeSession,
    interactionId: string,
    rawPayload: Record<string, unknown>,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* log.debug(`[interaction] routing to elicitation/create for ${interactionId}`);
      const questions = extractElicitationQuestions({ interactionId, kind: "userInput", payload: rawPayload });
      const params = buildElicitationParams(bridge.id, questions, rawPayload);
      const answer = yield* tolerate(clientRequest("elicitation/create", params), (cause) =>
        Effect.gen(function* () {
          yield* log.debug(`[interaction] elicitation/create threw: ${renderError(cause)}`);
          yield* tolerate(
            bridge.serve.resolveInteraction(interactionId, { action: "cancel", optionId: "deny" }),
            (fallback) => log.debug(`[interaction] fallback cancel resolution failed: ${renderError(fallback)}`),
          );
        }),
      );
      if (answer === undefined) return; // fallback resolution already ran
      const resolve = buildElicitationResolve(
        answer as { action?: string; content?: Record<string, unknown> } | null,
        questions,
      );
      yield* log.debug(`[interaction] resolving elicitation ${interactionId} with ${JSON.stringify(resolve)}`);
      yield* tolerate(bridge.serve.resolveInteraction(interactionId, resolve), (cause) =>
        log.debug(`[interaction] resolveInteraction failed: ${renderError(cause)}`),
      );
    });

  const runPermission = (
    bridge: BridgeSession,
    interactionId: string,
    rawPayload: Record<string, unknown>,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const rawOptions = (rawPayload.options as Array<Record<string, unknown>> | undefined) ?? [];
      const params = buildPermissionParams(bridge.id, rawPayload, bridge.translator.getLatestActiveToolCallId());
      yield* log.debug(`[interaction] requesting permission from client for ${params.toolCall.toolCallId}`);
      const answer = yield* tolerate(clientRequest("session/request_permission", params), (cause) =>
        Effect.gen(function* () {
          yield* log.debug(`[interaction] request_permission threw: ${renderError(cause)}`);
          const fallbackOpt = rawOptions[0]?.optionId ?? "allow";
          yield* tolerate(bridge.serve.resolveInteraction(interactionId, { optionId: fallbackOpt }), (fallback) =>
            log.debug(`[interaction] fallback resolution failed: ${renderError(fallback)}`),
          );
        }),
      );
      if (answer === undefined) return; // fallback resolution already ran
      const chosen = extractPermissionOptionId(
        answer as { outcome?: { outcome?: string; optionId?: string }; optionId?: string },
        rawOptions,
        params.options,
      );
      yield* log.debug(`[interaction] resolving ${interactionId} with optionId=${chosen}`);
      yield* tolerate(bridge.serve.resolveInteraction(interactionId, { optionId: chosen }), (cause) =>
        log.debug(`[interaction] resolveInteraction failed: ${renderError(cause)}`),
      );
    });

  // ---- session registry ----

  const createBridgeSession = (cwd: string, explicitSessionId?: string): Effect.Effect<BridgeSession> =>
    Effect.gen(function* () {
      const sessionId = explicitSessionId ?? crypto.randomUUID();
      const bridge: BridgeSession = {
        id: sessionId,
        serve: undefined as never,
        translator: new FrameTranslator((...parts) => void log.debug(...parts)),
        models: [],
        skills: [],
        handledInteractions: new Set<string>(),
        turn: Ref.makeUnsafe(Option.none()),
        quietFiber: Ref.makeUnsafe(Option.none()),
        dumpRef: Ref.makeUnsafe(false),
      };
      const serve = yield* deps.sessions.create(cwd, {
        onConversationFrame: onConversationFrame(bridge),
        onLifecycle: onLifecycle(bridge),
        onRequest: onRequest(bridge),
        onClosed: onClosed(bridge),
      });
      bridge.serve = serve;
      bridgeSessions.set(sessionId, bridge);
      return bridge;
    });

  const initializeNewSession = (method: string, bridge: BridgeSession): Effect.Effect<unknown, unknown> =>
    Effect.gen(function* () {
      const created = yield* bridge.serve
        .createSession()
        .pipe(Effect.mapError((cause) => new AcpMethodError({ method, message: cause.message })));
      let models = created.models;
      let current = created.currentModel;
      if (models.length === 0) {
        yield* log.debug(
          `[${method}] daemon advertised no models — falling back to catalog+presence (#33684 extraction)`,
        );
        models = yield* deps.fallbackModels;
      }
      bridge.models = models;
      bridge.skills = created.skills ?? [];
      bridge.currentMode = created.currentMode ?? bridge.currentMode;
      const currentModel = current
        ? (models.find((m) => `${m.providerId}/${m.modelId}` === current || m.modelId === current) ?? models[0])
        : models[0];
      if (currentModel !== undefined) {
        bridge.modelSelection = { providerId: currentModel.providerId, modelId: currentModel.modelId };
        bridge.thoughtLevel =
          bridge.thoughtLevel ??
          currentModel.reasoningDefaultLevel ??
          currentModel.reasoningLevels?.[0]?.value ??
          "max";
      }
      const modelsAcp = modelsToAcp(models, current);
      yield* log.debug(
        `[${method}] daemon=${created.daemonSessionId} models=${modelsAcp.availableModels.map((m) => m.modelId).join(", ")} skills=${bridge.skills.length}`,
      );
      yield* emitNotification("session/update", {
        sessionId: bridge.id,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: buildAvailableCommands(created.slashCommands ?? [], bridge.skills),
        },
      });
      const rawProj = (created.raw as { projection?: { contextUsed?: number; contextWindow?: number } } | undefined)
        ?.projection;
      const initialUsed = rawProj?.contextUsed ?? 0;
      const initialSize = currentModel?.contextWindow ?? rawProj?.contextWindow ?? 200_000;
      yield* emitNotification("session/update", {
        sessionId: bridge.id,
        update: { sessionUpdate: "usage_update", used: initialUsed, size: initialSize },
      });
      return {
        sessionId: bridge.id,
        models: modelsAcp,
        configOptions: buildConfigOptions(bridge),
        _meta: { t3SessionLoadReady: "replay_idle" },
      };
    });

  const selectModel = (bridge: BridgeSession, value: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
      bridge.modelSelection =
        slash >= 0
          ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
          : { providerId: "", modelId: value };
      const model = bridge.models.find(
        (m) => m.providerId === bridge.modelSelection?.providerId && m.modelId === bridge.modelSelection?.modelId,
      );
      if (model?.reasoningDefaultLevel) {
        bridge.thoughtLevel = model.reasoningDefaultLevel;
      }
      const options = buildConfigOptions(bridge);
      yield* emitNotification("session/update", {
        sessionId: bridge.id,
        update: { sessionUpdate: "config_option_update", configOptions: options },
      });
      const newSize = model?.contextWindow ?? 200_000;
      yield* emitNotification("session/update", {
        sessionId: bridge.id,
        update: {
          sessionUpdate: "usage_update",
          used: bridge.lastUsage ? bridge.lastUsage.inputTokens + bridge.lastUsage.outputTokens : 0,
          size: newSize,
        },
      });
    });

  // ---- method dispatch ----

  const dispatch = (method: string, params: Record<string, unknown>): Effect.Effect<unknown, unknown> =>
    Effect.gen(function* () {
      switch (method) {
        case "initialize": {
          return buildInitializeResult();
        }
        case "auth/authenticate": {
          // The daemon owns credentials — nothing to do.
          return {};
        }
        case "session/load":
        case "session/resume":
        case "session/new": {
          const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : process.cwd();
          const existingId =
            typeof params.sessionId === "string" && params.sessionId !== "" ? params.sessionId : undefined;
          const bridge = existingId !== undefined ? bridgeSessions.get(existingId) : undefined;
          if (bridge !== undefined) {
            return {
              sessionId: bridge.id,
              models: modelsToAcp(
                bridge.models,
                bridge.modelSelection
                  ? `${bridge.modelSelection.providerId}/${bridge.modelSelection.modelId}`
                  : undefined,
              ),
              configOptions: buildConfigOptions(bridge),
              _meta: { t3SessionLoadReady: "replay_idle" },
            };
          }
          const created = yield* createBridgeSession(cwd, existingId);
          return yield* initializeNewSession(method, created);
        }
        case "session/prompt": {
          const sessionId = String(params.sessionId ?? "");
          const bridge = yield* getSession(sessionId);
          const prompt = yield* decodePrompt(Array.isArray(params.prompt) ? params.prompt : []).pipe(
            Effect.mapError((cause) => new AcpMethodError({ method, message: cause.message })),
          );
          // If the user triggered a skill via T3 Code's /skill:<name> syntax, format it with
          // the skill's file link so the ZCode daemon recognizes it as a skill mention.
          const promptPayload = rewriteSkillMention(prompt.text, bridge.skills);
          const attachments: PromptAttachment[] = prompt.images.map((img, index) => {
            const mimeType = img.mimeType || "image/png";
            const ext = mimeType.split("/")[1] || "png";
            return {
              kind: "image",
              filename: `image_${index + 1}.${ext}`,
              mimeType,
              ...(img.data ? { dataBase64: img.data } : {}),
              ...(img.uri && img.uri.startsWith("file://") ? { localPath: img.uri.replace("file://", "") } : {}),
            };
          });
          const modelSelection =
            bridge.modelSelection !== undefined
              ? {
                  providerId: bridge.modelSelection.providerId,
                  modelId: bridge.modelSelection.modelId,
                  ...(bridge.thoughtLevel !== undefined ? { options: { reasoningLevel: bridge.thoughtLevel } } : {}),
                }
              : undefined;
          bridge.handledInteractions.clear();
          bridge.translator.startTurn();
          const sendResult = yield* bridge.serve
            .sendPrompt(promptPayload, modelSelection, attachments.length > 0 ? attachments : undefined)
            .pipe(Effect.mapError((cause) => new AcpMethodError({ method, message: cause.message })));
          // Turn lifecycle: the Deferred is completed from frame handlers.
          const state: TurnState = {
            deferred: Deferred.makeUnsafe<string, AcpMethodError>(),
            sawUpdate: false,
          };
          yield* Ref.set(bridge.turn, Option.some(state));
          state.initialGuard = yield* Effect.forkScoped(
            Effect.gen(function* () {
              yield* Effect.sleep("180 seconds");
              if (!state.sawUpdate) {
                yield* failTurn(bridge, "Turn timed out: no response received from daemon within 180 seconds");
              }
            }),
          );
          yield* log.debug(`[prompt] turn started (inputId=${sendResult.inputId})`);
          const stopReason = yield* Deferred.await(state.deferred);
          yield* log.debug(`[prompt] turn promise resolved (${stopReason})`);
          return {
            stopReason,
            ...(bridge.lastUsage !== undefined ? { usage: bridge.lastUsage } : {}),
          };
        }
        case "session/set_model": {
          const sessionId = String(params.sessionId ?? "");
          const bridge = yield* getSession(sessionId);
          yield* selectModel(bridge, String(params.modelId ?? ""));
          return { configOptions: buildConfigOptions(bridge) };
        }
        case "session/set_config_option": {
          // t3code sends {sessionId, configId, value} (SetSessionConfigOptionRequest);
          // the response MUST carry the updated configOptions array.
          const sessionId = String(params.sessionId ?? "");
          const bridge = yield* getSession(sessionId);
          const optionId = String(params.configId ?? params.configOptionId ?? params.id ?? "");
          const value = String(params.value ?? params.currentValue ?? "");
          yield* log.debug(`[config] set ${optionId} = ${value}`);
          if (optionId === "model") {
            yield* selectModel(bridge, value);
            return { configOptions: buildConfigOptions(bridge) };
          }
          if (
            optionId === "thought" ||
            optionId === "reasoning" ||
            optionId === "thinking_level" ||
            optionId === "thinking"
          ) {
            bridge.thoughtLevel = value;
            const options = buildConfigOptions(bridge);
            yield* emitNotification("session/update", {
              sessionId: bridge.id,
              update: { sessionUpdate: "config_option_update", configOptions: options },
            });
            return { configOptions: options };
          }
          if (optionId === "mode") {
            yield* tolerate(bridge.serve.setMode(value), (cause) =>
              log.debug(`[config] setMode failed: ${renderError(cause)}`),
            );
            bridge.currentMode = value;
            const options = buildConfigOptions(bridge);
            yield* emitNotification("session/update", {
              sessionId: bridge.id,
              update: { sessionUpdate: "config_option_update", configOptions: options },
            });
            return { configOptions: options };
          }
          return yield* new AcpMethodError({ method, message: `unknown config option ${optionId}` });
        }
        case "session/set_mode": {
          const sessionId = String(params.sessionId ?? "");
          const bridge = yield* getSession(sessionId);
          const modeId = String(params.modeId ?? "");
          yield* tolerate(bridge.serve.setMode(modeId), (cause) =>
            log.debug(`[session/set_mode] failed: ${renderError(cause)}`),
          );
          bridge.currentMode = modeId;
          return {};
        }
        case "session/cancel": {
          const sessionId = String(params.sessionId ?? "");
          const bridge = bridgeSessions.get(sessionId);
          if (bridge === undefined) return {};
          yield* tolerate(bridge.serve.sendCommand("stop", {}), (cause) =>
            log.debug(`[cancel] stop rejected: ${renderError(cause)}`),
          );
          yield* endTurn(bridge, "cancelled");
          return {};
        }
        case "session/unload": {
          // New (registry-prune fix): release the session's channel and drop it.
          const sessionId = String(params.sessionId ?? "");
          const bridge = bridgeSessions.get(sessionId);
          if (bridge === undefined) return {};
          yield* endTurn(bridge, "cancelled");
          bridgeSessions.delete(sessionId);
          yield* bridge.serve.dispose;
          yield* log.debug(`[session] unloaded ${sessionId}`);
          return {};
        }
        default:
          return yield* new AcpMethodError({ method, message: `unsupported ACP method ${method}` });
      }
    }).pipe(Effect.scoped);

  return AcpServer.of({
    handle: (method, params) =>
      dispatch(method, params).pipe(
        Effect.mapError((cause) => new AcpMethodError({ method, message: renderError(cause) })),
      ),
  });
};

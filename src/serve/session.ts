/**
 * Session layer over the daemon channel — mirrors the owner's PR #34713
 * adapter (zcodeServeConnection.ts): project resolution by cwd, workspace
 * initialize, createSession (models come from the daemon), subscribe
 * foreground conversation frames, sendPrompt, interaction resolution.
 *
 * Channel names: "zcode-session" (createSession) and "zcode-agent"
 * (initialize, subscribeConversationV4, sendPrompt, sendConversationCommandV4,
 * readSession, setMode, resolveInteraction …).
 *
 * The pre-rewrite fire-and-forget `void this.subscribeConversation(...)` is
 * now a detached fiber whose failure is logged, and `saveProject` /
 * `createSession` results are decoded with tolerant Schemas instead of
 * four-shape `as` probing. Each session owns an internal Scope holding its
 * WS channel; `dispose()` closes it (used by session/unload).
 */
import { Clock, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import * as ScopeType from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { ChannelClosed, RpcError, RpcTimeout, SessionError, renderError, tolerate } from "../errors.ts";
import { Log } from "../log.ts";
import { ChannelClient, type ServerRequestHandler } from "./channel.ts";
import { Daemon, type DaemonConnection } from "./daemon.ts";

const CLIENT_ID = "zcode-serve-acp";

export interface AvailableModel {
  providerId: string;
  modelId: string;
  label?: string;
  providerLabel?: string;
  contextWindow?: number;
  reasoningLevels?: Array<{ value: string; label: string }>;
  reasoningDefaultLevel?: string;
}

export interface DiscoveredSkill {
  name: string;
  description?: string;
  path?: string;
}

export interface PromptAttachment {
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}

export interface CreateSessionResult {
  daemonSessionId: string;
  models: AvailableModel[];
  currentModel?: string;
  currentMode?: string;
  slashCommands?: Array<{ name: string; description?: string }>;
  skills?: DiscoveredSkill[];
  raw: unknown;
}

export interface SessionHandlers {
  onConversationFrame: (payload: unknown) => Effect.Effect<void, unknown>;
  onLifecycle: (payload: unknown) => Effect.Effect<void, unknown>;
  onRequest: ServerRequestHandler;
  onClosed: (reason: string) => Effect.Effect<void, unknown>;
}

export interface ServeSession {
  readonly createSession: (
    modelSelection?: unknown,
  ) => Effect.Effect<CreateSessionResult, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  readonly sendPrompt: (
    text: string,
    modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } },
    attachments?: PromptAttachment[],
  ) => Effect.Effect<{ inputId: string }, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  readonly resolveInteraction: (
    interactionId: string,
    answer: unknown,
  ) => Effect.Effect<unknown, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  readonly setMode: (mode: string) => Effect.Effect<void, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  readonly sendCommand: (
    type: string,
    payload: unknown,
    expectedForegroundExecutionId?: string,
  ) => Effect.Effect<unknown, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  /** Close the channel scope — used by session/unload. */
  readonly dispose: () => Effect.Effect<void, unknown>;
}

export class ServeSessionFactory extends Context.Service<
  ServeSessionFactory,
  {
    /** Create one daemon-backed session. Services are captured at layer build
     *  time; the WS channel lives in the session's internal Scope. */
    create(cwd: string, handlers: SessionHandlers): Effect.Effect<ServeSession>;
  }
>()("zcode-serve-acp/ServeSessionFactory") {
  /** Compose with a WebSocketConstructor layer in bin.ts; tests provide fakes. */
  static readonly layerNoDeps: Layer.Layer<ServeSessionFactory, never, Daemon | Log | Socket.WebSocketConstructor> =
    Layer.effect(
      ServeSessionFactory,
      Effect.gen(function* () {
        const daemon = yield* Daemon;
        const log = yield* Log;
        const wsConstructor = yield* Socket.WebSocketConstructor;
        return ServeSessionFactory.of({
          create: (cwd, handlers) => makeSession(daemon, log, wsConstructor, cwd, handlers),
        });
      }),
    );
}

type ServeError = SessionError | RpcError | RpcTimeout | ChannelClosed;

interface WorkspaceInfo {
  workspacePath: string;
  workspaceIdentity: string;
  projectId: string;
}

const makeSession = (
  daemon: Daemon["Service"],
  log: Log["Service"],
  wsConstructor: Socket.WebSocketConstructor["Service"],
  cwd: string,
  handlers: SessionHandlers,
): Effect.Effect<ServeSession> =>
  Effect.sync(() => {
    const scope: ScopeType.Closeable = ScopeType.makeUnsafe();
    const connectionRef = Ref.makeUnsafe<Option.Option<DaemonConnection>>(Option.none());
    const channelRef = Ref.makeUnsafe<Option.Option<ChannelClient>>(Option.none());
    const workspaceRef = Ref.makeUnsafe<Option.Option<WorkspaceInfo>>(Option.none());
    const daemonSessionRef = Ref.makeUnsafe<Option.Option<string>>(Option.none());
    const subscribedRef = Ref.makeUnsafe(false);

    const ensureConnection: Effect.Effect<DaemonConnection, SessionError> = Effect.gen(function* () {
      const existing = yield* Ref.get(connectionRef);
      if (Option.isSome(existing)) return existing.value;
      const connection = yield* daemon
        .connect()
        .pipe(Effect.mapError((cause) => new SessionError({ message: cause.message })));
      yield* Ref.set(connectionRef, Option.some(connection));
      return connection;
    });

    const getChannel: Effect.Effect<ChannelClient, ServeError> = Effect.gen(function* () {
      const existing = yield* Ref.get(channelRef);
      if (Option.isSome(existing)) return existing.value;
      const connection = yield* ensureConnection;
      const capability = yield* daemon
        .getCapability(connection)
        .pipe(Effect.mapError((cause) => new SessionError({ message: cause.message })));
      const wsUrl =
        `ws://${connection.status.host}:${connection.status.port}${connection.wsPath}` +
        (connection.token ? `?token=${encodeURIComponent(connection.token)}` : "");
      const channel = yield* ChannelClient.connect(
        wsUrl,
        { "x-zcode-rpc-host-capability": capability },
        {
          onRequest: handlers.onRequest,
          onClose: handlers.onClosed,
        },
        log,
      ).pipe(
        ScopeType.provide(scope),
        Effect.provideService(Socket.WebSocketConstructor, wsConstructor),
        Effect.mapError((cause) => new SessionError({ message: renderError(cause) })),
      );
      yield* Ref.set(channelRef, Option.some(channel));
      yield* log.debug(`[session] channel ready ${wsUrl.replace(/token=[^&]*/, "token=…")}`);
      return channel;
    });

    const call = (method: string, arg?: unknown, timeoutMs = 30_000) =>
      Effect.flatMap(getChannel, (channel) => channel.call("zcode-agent", method, arg, timeoutMs));

    const callSession = (method: string, arg?: unknown, timeoutMs = 30_000) =>
      Effect.flatMap(getChannel, (channel) => channel.call("zcode-session", method, arg, timeoutMs));

    const ensureWorkspace: Effect.Effect<WorkspaceInfo, ServeError> = Effect.gen(function* () {
      const existing = yield* Ref.get(workspaceRef);
      if (Option.isSome(existing)) return existing.value;
      const channel = yield* getChannel;
      // Repeated attaches do not mint duplicate projects — the daemon dedupes by rootPath.
      const saved = yield* tolerate(channel.call("project", "saveProject", { roots: [cwd] }, 30_000), (cause) =>
        log.debug(`[session] saveProject failed (${renderError(cause)})`),
      );
      const projectId = saved === undefined ? undefined : decodeSaveProjectId(saved);
      if (saved !== undefined) {
        yield* log.debug(`[session] saveProject → ${projectId}`);
      }
      if (projectId === undefined) {
        return yield* new SessionError({ message: `cannot resolve a zcode server project for ${cwd}` });
      }
      const workspace: WorkspaceInfo = { workspacePath: cwd, workspaceIdentity: cwd, projectId };
      yield* Ref.set(workspaceRef, Option.some(workspace));
      // Workspace initialize — the adapter ignores failures with a warning.
      yield* tolerate(channel.call("zcode-agent", "initialize", workspace, 30_000), (cause) =>
        log.debug(`[session] zcode-agent.initialize failed (continuing): ${renderError(cause)}`),
      );
      return workspace;
    });

    // listener disposers (from channel.listen) drained by dispose() on session/unload
    const listenerDisposers: Array<Effect.Effect<void, unknown>> = [];

    const subscribeConversation = (daemonSessionId: string, workspace: WorkspaceInfo): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if ((yield* Ref.get(subscribedRef)) === true) return;
        yield* Ref.set(subscribedRef, true);
        const channel = yield* getChannel;
        yield* channel.call(
          "zcode-agent",
          "subscribeConversationV4",
          {
            sessionId: daemonSessionId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            visibility: "foreground",
          },
          30_000,
        );
        yield* log.debug(`[session] subscribed conversation ${daemonSessionId}`);
        const topic = `conversation/${daemonSessionId}`;
        listenerDisposers.push(
          yield* channel.listen(
            "zcode-agent",
            "onDynamicConversationFrame",
            {
              sessionId: daemonSessionId,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
            },
            (payload) =>
              Effect.gen(function* () {
                // The daemon pushes workspace-wide frames — filter to OUR conversation
                // (client-side filtering, same as the upstream adapter).
                const p = payload as { topic?: string; frame?: { topic?: string } } | undefined;
                const frameTopic = p?.frame?.topic ?? p?.topic;
                if (frameTopic !== undefined && frameTopic !== topic) return;
                yield* handlers.onConversationFrame(payload);
              }),
          ),
        );
        listenerDisposers.push(
          yield* channel.listen(
            "zcode-agent",
            "onDynamicSessionLifecycle",
            {
              sessionId: daemonSessionId,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
            },
            (payload) =>
              Effect.gen(function* () {
                const lifecycleSessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
                if (lifecycleSessionId !== undefined && lifecycleSessionId !== daemonSessionId) return;
                yield* handlers.onLifecycle(payload);
              }),
          ),
        );
      });

    const requireDaemonSession: Effect.Effect<string, SessionError> = Effect.gen(function* () {
      const id = yield* Ref.get(daemonSessionRef);
      if (Option.isNone(id)) {
        return yield* new SessionError({ message: "no daemon session — call createSession first" });
      }
      return id.value;
    });

    const workspaceIdentifiers = Effect.gen(function* () {
      const ws = yield* Ref.get(workspaceRef);
      return Option.isSome(ws)
        ? { workspacePath: ws.value.workspacePath, workspaceIdentity: ws.value.workspaceIdentity }
        : { workspacePath: cwd, workspaceIdentity: cwd };
    });

    const createSession = (modelSelection?: unknown): Effect.Effect<CreateSessionResult, ServeError> =>
      Effect.gen(function* () {
        const workspace = yield* ensureWorkspace;
        const arg: Record<string, unknown> = {
          projectId: workspace.projectId,
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
        };
        if (modelSelection !== undefined && modelSelection !== null) arg.model = modelSelection;
        const result = yield* callSession("createSession", arg, 150_000);
        const decoded = decodeCreateSession(result);
        if (decoded === undefined) {
          return yield* new SessionError({
            message: `createSession returned no sessionId: ${JSON.stringify(result).slice(0, 400)}`,
          });
        }
        yield* Ref.set(daemonSessionRef, Option.some(decoded.daemonSessionId));
        yield* Effect.forkDetach(
          tolerate(subscribeConversation(decoded.daemonSessionId, workspace), (cause) =>
            log.debug(`[session] subscribeConversationV4 failed: ${renderError(cause)}`),
          ),
        );
        const skills = yield* Effect.flatMap(getChannel, (channel) =>
          tolerate(
            channel.call(
              "skills",
              "list",
              {
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              },
              5_000,
            ),
            (cause) => log.debug(`[session] skills.list failed: ${renderError(cause)}`),
          ).pipe(
            Effect.map((raw) => decodeSkills(raw)),
            Effect.map((skills) => skills ?? ([] as DiscoveredSkill[])),
          ),
        );
        yield* log.debug(`[session] discovered ${skills.length} skills from daemon`);
        return {
          daemonSessionId: decoded.daemonSessionId,
          models: decoded.models,
          currentModel: decoded.currentModel,
          currentMode: decoded.currentMode,
          slashCommands: decoded.slashCommands,
          skills,
          raw: result,
        } satisfies CreateSessionResult;
      });

    const sendPrompt: ServeSession["sendPrompt"] = (text, modelSelection, attachments) =>
      Effect.gen(function* () {
        const daemonSessionId = yield* requireDaemonSession;
        const ws = yield* workspaceIdentifiers;
        const inputId = crypto.randomUUID();
        yield* call(
          "sendPrompt",
          {
            sessionId: daemonSessionId,
            inputId,
            content: text,
            workspacePath: ws.workspacePath,
            workspaceIdentity: ws.workspaceIdentity,
            ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
            ...(modelSelection !== undefined && modelSelection.modelId !== "" ? { modelSelection } : {}),
          },
          60_000,
        );
        return { inputId };
      });

    const resolveInteraction: ServeSession["resolveInteraction"] = (interactionId, answer) =>
      Effect.gen(function* () {
        const daemonSessionId = yield* requireDaemonSession;
        const ws = yield* workspaceIdentifiers;
        return yield* call(
          "sendConversationCommandV4",
          {
            workspacePath: ws.workspacePath,
            workspaceIdentity: ws.workspaceIdentity,
            envelope: {
              commandId: crypto.randomUUID(),
              clientId: CLIENT_ID,
              sessionId: daemonSessionId,
              type: "resolveInteraction",
              payload: { interactionId, answer },
              issuedAt: yield* Clock.currentTimeMillis,
            },
          },
          30_000,
        );
      });

    const setMode: ServeSession["setMode"] = (mode) =>
      Effect.gen(function* () {
        const daemonSessionId = yield* requireDaemonSession;
        const ws = yield* workspaceIdentifiers;
        yield* call(
          "setMode",
          {
            sessionId: daemonSessionId,
            mode,
            workspacePath: ws.workspacePath,
            workspaceIdentity: ws.workspaceIdentity,
          },
          30_000,
        );
      });

    const sendCommand: ServeSession["sendCommand"] = (type, payload, expectedForegroundExecutionId) =>
      Effect.gen(function* () {
        const daemonSessionId = yield* requireDaemonSession;
        const ws = yield* workspaceIdentifiers;
        return yield* call(
          "sendConversationCommandV4",
          {
            workspacePath: ws.workspacePath,
            workspaceIdentity: ws.workspaceIdentity,
            envelope: {
              commandId: crypto.randomUUID(),
              clientId: CLIENT_ID,
              sessionId: daemonSessionId,
              type,
              payload,
              ...(expectedForegroundExecutionId !== undefined ? { expectedForegroundExecutionId } : {}),
              issuedAt: yield* Clock.currentTimeMillis,
            },
          },
          30_000,
        );
      });

    const disposeEffect = Effect.gen(function* () {
      for (const disposer of listenerDisposers.splice(0)) {
        yield* Effect.orElseSucceed(disposer, () => undefined);
      }
      const channel = yield* Ref.get(channelRef);
      if (Option.isSome(channel)) yield* channel.value.close();
      yield* ScopeType.close(scope, Exit.succeed(undefined)).pipe(Effect.orElseSucceed(() => undefined));
    });
    const dispose = () => disposeEffect;

    return {
      createSession,
      sendPrompt,
      resolveInteraction,
      setMode,
      sendCommand,
      dispose,
    } satisfies ServeSession;
  });

// ---------- tolerant result decoding (pre-rewrite shape probing, typed) ----------

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * `project.saveProject` has been observed to answer as a bare string id, or
 * `{id}`, or `{project:{id}}`, or `{result:{id}}`.
 */
const decodeSaveProjectId = (value: unknown): string | undefined => {
  if (typeof value === "string" && value !== "") return value;
  const r = rec(value);
  if (r === undefined) return undefined;
  for (const key of ["id", ["project", "id"], ["result", "id"]] as const) {
    if (typeof key === "string") {
      const direct = r[key];
      if (typeof direct === "string" && direct !== "") return direct;
    } else {
      const nested = rec(r[key[0]])?.[key[1]];
      if (typeof nested === "string" && nested !== "") return nested;
    }
  }
  return undefined;
};

const CreateSessionShape = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  session: Schema.optional(
    Schema.Struct({ sessionId: Schema.optional(Schema.String), mode: Schema.optional(Schema.String) }),
  ),
  id: Schema.optional(Schema.String),
  settings: Schema.optional(
    Schema.Struct({
      model: Schema.optional(
        Schema.Struct({
          current: Schema.optional(
            Schema.Struct({
              ref: Schema.optional(
                Schema.Struct({ providerId: Schema.optional(Schema.String), modelId: Schema.optional(Schema.String) }),
              ),
              options: Schema.optional(Schema.Struct({ reasoningLevel: Schema.optional(Schema.String) })),
            }),
          ),
          available: Schema.optional(
            Schema.Array(
              Schema.Struct({
                ref: Schema.optional(
                  Schema.Struct({
                    providerId: Schema.optional(Schema.String),
                    modelId: Schema.optional(Schema.String),
                  }),
                ),
                label: Schema.optional(Schema.String),
                providerLabel: Schema.optional(Schema.String),
                contextWindow: Schema.optional(Schema.Finite),
                reasoning: Schema.optional(
                  Schema.Struct({
                    levels: Schema.optional(
                      Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.optional(Schema.String) })),
                    ),
                    defaultLevel: Schema.optional(Schema.String),
                  }),
                ),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
  slashCommands: Schema.optional(Schema.Unknown),
});
type CreateSessionShape = typeof CreateSessionShape.Type;

const decodeCreateSessionShape = Schema.decodeUnknownSync(CreateSessionShape);

interface DecodedCreate {
  daemonSessionId: string;
  models: AvailableModel[];
  currentModel?: string;
  currentMode?: string;
  slashCommands?: Array<{ name: string; description?: string }>;
}

const decodeCreateSession = (result: unknown): DecodedCreate | undefined => {
  let shape: CreateSessionShape;
  try {
    shape = decodeCreateSessionShape(result);
  } catch {
    return undefined;
  }
  const daemonSessionId = shape.sessionId ?? shape.session?.sessionId ?? shape.id;
  if (daemonSessionId === undefined || daemonSessionId === "") return undefined;

  const settings = shape.settings ?? {};
  const models: AvailableModel[] = (settings.model?.available ?? [])
    .map((m) => ({
      providerId: m.ref?.providerId ?? "",
      modelId: m.ref?.modelId ?? "",
      ...(m.label !== undefined ? { label: m.label } : {}),
      ...(m.providerLabel !== undefined ? { providerLabel: m.providerLabel } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      reasoningLevels: m.reasoning?.levels?.map((l) => ({ value: l.value, label: l.label ?? l.value })),
      ...(m.reasoning?.defaultLevel !== undefined ? { reasoningDefaultLevel: m.reasoning.defaultLevel } : {}),
    }))
    .filter((m) => m.modelId !== "");

  const currentRef = settings.model?.current;
  const current =
    currentRef?.ref?.providerId !== undefined && currentRef?.ref?.modelId !== undefined
      ? `${currentRef.ref.providerId}/${currentRef.ref.modelId}`
      : currentRef?.ref?.modelId;

  const rawSlash = Array.isArray(shape.slashCommands) ? (shape.slashCommands as Array<Record<string, unknown>>) : [];
  const slashCommands = rawSlash
    .filter((c) => typeof c?.name === "string" && (c.name as string) !== "")
    .map((c) => ({
      name: c.name as string,
      ...(typeof c.description === "string" ? { description: c.description } : {}),
    }));

  const currentMode = shape.session?.mode;

  return {
    daemonSessionId,
    models,
    ...(current !== undefined ? { currentModel: current } : {}),
    ...(currentMode !== undefined ? { currentMode } : {}),
    slashCommands,
  };
};

const decodeSkills = (result: unknown): DiscoveredSkill[] => {
  const r = rec(result);
  const rawSkills = Array.isArray(r?.["skills"]) ? (r!["skills"] as Array<Record<string, unknown>>) : [];
  return rawSkills
    .filter(
      (s) =>
        s !== null &&
        typeof s === "object" &&
        s["enabled"] !== false &&
        typeof s["name"] === "string" &&
        (s["name"] as string).trim() !== "",
    )
    .map((s) => {
      const name = (s["name"] as string).trim();
      const description = typeof s["description"] === "string" ? s["description"].trim() : undefined;
      const path = typeof s["path"] === "string" ? s["path"] : undefined;
      return {
        name,
        ...(description !== undefined && description !== "" ? { description } : {}),
        ...(path !== undefined ? { path } : {}),
      };
    });
};

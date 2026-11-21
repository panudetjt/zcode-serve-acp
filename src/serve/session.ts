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
 * WS channel; `dispose` closes it (used by session/unload).
 *
 * Channel recovery (issue #5): the memoized Channel and Daemon connection are
 * no longer trusted forever. A channel close invalidates every cached
 * artifact; each channel dispatch re-checks the daemon's local status file
 * for a restarted daemon (pid/startedAt/port change); a Turn dispatch runs a
 * sub-second round-trip probe first to catch silent half-open sockets; and
 * reconnection runs on a bounded budget — if the Daemon stays unreachable the
 * Bridge exits non-zero so the Client's runtime recovery restarts it.
 */
import { Clock, Context, Effect, Exit, Layer, Option, Ref, Result, Schema, Semaphore } from "effect";
import * as ScopeType from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { ChannelClosed, RpcError, RpcTimeout, SessionError, renderError, tolerate } from "../errors.ts";
import { Log } from "../log.ts";
import { ChannelClient, type ServerRequestHandler } from "./channel.ts";
import { Daemon, type DaemonConnection } from "./daemon.ts";
import { BridgeExit } from "./bridge.ts";
import type { McpServer } from "../acp/protocol.ts";

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

/**
 * One entry of a `session/subagents` result. Ground truth (server-core.js
 * 3.19.0): method id `sessionSubagents: "session/subagents"` (:13209), host
 * handler `listSessionSubagents` forwarding `{ sessionId, endedCursor,
 * endedLimit ?? 20 }` (:64180), entry schema :11705 — childSessionId, agentId?,
 * toolCallId? (the spawning Agent/Task tool call), subagentType, title,
 * summary?, startedAt?, endedAt?; running statuses `running|waiting|blocked`
 * (:11715), ended statuses `success|failed|cancelled|lost` (:11718).
 */
export interface SubagentEntry {
  childSessionId: string;
  toolCallId?: string;
  subagentType: string;
  title?: string;
  summary?: string;
  status: string;
}

/**
 * `session/subagents` result shape (zcodeSessionSubagentsResultSchema,
 * server-core.js 3.19.0:11721): revision, childSessionIds, running[], and a
 * paged ended{total, items, nextCursor?}. This bridge reads it while a turn
 * runs — for the batch overview the client sees and to bind child sessions
 * onto cards when subagent rows arrived without childSessionId.
 */
export interface SubagentsSnapshot {
  revision: number;
  running: SubagentEntry[];
  ended: { total: number; items: SubagentEntry[] };
}

/**
 * Handler callbacks the host app wires into a session. `E` is the app's own
 * handler failure channel, threaded through to the channel client (where event
 * dispatch tolerates it and `onClose` may surface it); it is inferred from the
 * handlers passed to `ServeSessionFactory.create`, so the ACP server's typed
 * channels flow down without a cast. Defaults to `never` — a session whose
 * handlers cannot fail.
 */
export interface SessionHandlers<E = never> {
  onConversationFrame: (payload: unknown) => Effect.Effect<void, E>;
  /** Frames of child conversations this session subscribed via subscribeChild. */
  onChildFrame: (childSessionId: string, payload: unknown) => Effect.Effect<void, E>;
  onLifecycle: (payload: unknown) => Effect.Effect<void, E>;
  onRequest: ServerRequestHandler<E>;
  onClosed: (reason: string) => Effect.Effect<void, E>;
}

export interface DaemonMcpServerHttp {
  name: string;
  type: "http" | "sse";
  url: string;
  headers: Array<{ name: string; value: string }>;
  isolation: "session";
  alwaysLoad: true;
}

export interface DaemonMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  isolation: "session";
  alwaysLoad: true;
}

export type DaemonMcpServer = DaemonMcpServerHttp | DaemonMcpServerStdio;

export function toDaemonMcpServer(server: McpServer): DaemonMcpServer {
  if ("type" in server && (server.type === "http" || server.type === "sse")) {
    return {
      name: server.name,
      type: server.type,
      url: server.url,
      headers: server.headers ? server.headers.map((h) => ({ name: h.name, value: h.value })) : [],
      isolation: "session",
      alwaysLoad: true,
    };
  }
  return {
    name: server.name,
    command: server.command,
    args: server.args ? [...server.args] : [],
    env: server.env ? server.env.map((e) => ({ name: e.name, value: e.value })) : [],
    isolation: "session",
    alwaysLoad: true,
  };
}

export interface ServeSession {
  readonly createSession: (
    modelSelection?: unknown,
    mcpServers?: readonly McpServer[],
  ) => Effect.Effect<CreateSessionResult, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  readonly setMcpServers: (
    mcpServers: readonly McpServer[],
  ) => Effect.Effect<void, SessionError | RpcError | RpcTimeout | ChannelClosed>;
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
  /**
   * List the session's subagent children (`session/subagents` RPC). Fired
   * while a turn runs: the ACP layer turns the snapshot into a batch overview
   * and binds child sessions onto cards that rows arrived without a
   * childSessionId for. `endedLimit` defaults to the daemon default (20).
   */
  readonly listSubagents: (
    endedLimit?: number,
  ) => Effect.Effect<SubagentsSnapshot, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  /**
   * Subscribe a child conversation so its frames flow to `onChildFrame`. The
   * daemon does not inline child rows — subagentRowSchema.childSessionId
   * documents the drill-down contract: "存在 → UI 可下钻订阅
   * conversation/<childSessionId>（不内嵌 child rows）" (server-core.js
   * 3.19.0:7436). Subscribes with visibility "background", the host's own
   * pattern for non-foreground consumers (:66895). Idempotent per child.
   */
  readonly subscribeChild: (
    childSessionId: string,
  ) => Effect.Effect<void, SessionError | RpcError | RpcTimeout | ChannelClosed>;
  /** Best-effort unsubscribe once the child settles. Never fails. */
  readonly unsubscribeChild: (childSessionId: string) => Effect.Effect<void>;
  /**
   * Best-effort teardown of the session's channel scope — used by
   * session/unload. Effect-valued property (Effect is already lazy; a
   * zero-arg method adds indirection): every step — listener disposal,
   * channel close, scope close — swallows its own failure, so dispose never
   * fails.
   */
  readonly dispose: Effect.Effect<void>;
}

export class ServeSessionFactory extends Context.Service<
  ServeSessionFactory,
  {
    /** Create one daemon-backed session. Services are captured at layer build
     *  time; the WS channel lives in the session's internal Scope. */
    create<E>(cwd: string, handlers: SessionHandlers<E>): Effect.Effect<ServeSession>;
  }
>()("zcode-serve-acp/ServeSessionFactory") {
  /** Compose with a WebSocketConstructor layer in bin.ts; tests provide fakes. */
  static readonly layerNoDeps: Layer.Layer<
    ServeSessionFactory,
    never,
    Daemon | Log | Socket.WebSocketConstructor | BridgeExit
  > = Layer.effect(
    ServeSessionFactory,
    Effect.gen(function* () {
      const daemon = yield* Daemon;
      const log = yield* Log;
      const wsConstructor = yield* Socket.WebSocketConstructor;
      const bridgeExit = yield* BridgeExit;
      return ServeSessionFactory.of({
        create: (cwd, handlers) => makeSession(daemon, log, wsConstructor, bridgeExit, cwd, handlers),
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

const makeSession = <E>(
  daemon: Daemon["Service"],
  log: Log["Service"],
  wsConstructor: Socket.WebSocketConstructor["Service"],
  bridgeExit: BridgeExit["Service"],
  cwd: string,
  handlers: SessionHandlers<E>,
): Effect.Effect<ServeSession> =>
  Effect.sync(() => {
    const scope: ScopeType.Closeable = ScopeType.makeUnsafe();
    const connectionRef = Ref.makeUnsafe<Option.Option<DaemonConnection>>(Option.none());
    const channelRef = Ref.makeUnsafe<Option.Option<ChannelClient<E>>>(Option.none());
    const workspaceRef = Ref.makeUnsafe<Option.Option<WorkspaceInfo>>(Option.none());
    // One invariant, one ref: a daemon session always rides with the workspace
    // it was created against (both are set together by createSession).
    const sessionRef = Ref.makeUnsafe<Option.Option<{ daemonSessionId: string; workspace: WorkspaceInfo }>>(
      Option.none(),
    );
    const mcpServersRef = Ref.makeUnsafe<Option.Option<DaemonMcpServer[]>>(Option.none());
    const subscribedRef = Ref.makeUnsafe(false);
    // Child conversation topics subscribed for live subagent drill-down — also
    // the routing table for the frame listener below.
    const childTopics = new Set<string>();
    const inFlightSubscribes = new Set<string>();
    const cancelledSubscribes = new Set<string>();
    // Bumped on every invalidation so a reconnection that waited on the
    // permit can tell "another fiber reconnected while I waited" (adopt its
    // channel) apart from "the channel I deemed stale is still cached".
    const connectionEpoch = Ref.makeUnsafe(0);
    // Generation of the currently-cached channel. Each dial claims the next
    // generation; a close event belonging to a superseded channel (a late
    // pump death arriving after a reconnect already landed) is ignored — it
    // must not wipe the fresh connection or notify the Client (issue #5).
    const channelGenRef = Ref.makeUnsafe(0);

    // ---- issue #5: watchdog, lazy reconnection, fail-fast exit -------------
    //
    // Provenance (server-core.js 3.19.0, re-verified live): run/status.json
    // carries pid + startedAt + host + port + state — a daemon restart mints
    // a new process (new pid AND startedAt) and may bind a new port. On the
    // conversation adapter, `zcode-agent`/`helloConversationV4` is the
    // lightest channel round-trip available (`assertOpen` + hello payload, no
    // state beyond the `helloIssued` flag that `initializeConversationV4`
    // requires anyway) — it is the pre-flight probe.
    const PROBE_TIMEOUT_MS = 900;
    const RECOVERY_ATTEMPTS = 2;
    const RECOVERY_RETRY_DELAY = "1 second";
    // Reconnection is serialized per session: concurrent getChannel callers
    // (event fibers, the next prompt) wait on this permit and then adopt the
    // fresh channel instead of dialing a second one on top of the in-flight
    // recovery.
    const reconnectPermit = Semaphore.makeUnsafe(1);

    /**
     * Drop every cached connection artifact (issue #5 state invalidation).
     * Listener disposers captured on a dead channel only ever write to that
     * dead channel (their writes are tolerated inside the disposer), so they
     * are dropped without draining. Clearing subscribedRef forces the
     * conversation re-subscription to happen on the fresh channel.
     */
    const invalidateConnection: Effect.Effect<void> = Effect.gen(function* () {
      listenerDisposers.splice(0);
      yield* Ref.set(channelRef, Option.none());
      yield* Ref.set(connectionRef, Option.none());
      yield* Ref.set(subscribedRef, false);
      yield* Ref.update(connectionEpoch, (epoch) => epoch + 1);
    });

    /**
     * Watchdog: compare the daemon's local status file against the memoized
     * connection. A missing/unreadable status file is treated as transient —
     * invalidation only ever happens on positive evidence of a different or
     * unready daemon (same tolerance as the Daemon layer's own reads).
     */
    const connectionStillValid = (connection: DaemonConnection): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const status = yield* daemon.readStatus;
        if (status === undefined) return true;
        if (status.state !== "ready") return false;
        if (status.host !== connection.status.host || status.port !== connection.status.port) return false;
        if (connection.status.pid !== undefined && status.pid !== undefined && status.pid !== connection.status.pid) {
          return false;
        }
        if (
          connection.status.startedAt !== undefined &&
          status.startedAt !== undefined &&
          status.startedAt !== connection.status.startedAt
        ) {
          return false;
        }
        return true;
      });

    const ensureConnection: Effect.Effect<DaemonConnection, SessionError> = Effect.gen(function* () {
      const existing = yield* Ref.get(connectionRef);
      if (Option.isSome(existing)) return existing.value;
      const connection = yield* daemon.connect.pipe(
        Effect.mapError((cause) => new SessionError({ message: cause.message })),
      );
      yield* Ref.set(connectionRef, Option.some(connection));
      return connection;
    });

    /**
     * Fresh dial: status + ingress token (via ensureConnection), single-use
     * capability, WS channel. Runs in the session's internal Scope.
     */
    const connectChannel: Effect.Effect<ChannelClient<E>, ServeError> = Effect.gen(function* () {
      const connection = yield* ensureConnection;
      const capability = yield* daemon
        .getCapability(connection)
        .pipe(Effect.mapError((cause) => new SessionError({ message: cause.message })));
      const wsUrl =
        `ws://${connection.status.host}:${connection.status.port}${connection.wsPath}` +
        (connection.token ? `?token=${encodeURIComponent(connection.token)}` : "");
      // Claim the next channel generation for this dial — its close handler
      // only acts while this generation is still current. The claim is
      // published BEFORE the dial so a late close from the superseded
      // channel (arriving during the handshake) is already recognized as
      // stale and cannot wipe the in-flight connection state.
      const channelGen = (yield* Ref.get(channelGenRef)) + 1;
      yield* Ref.set(channelGenRef, channelGen);
      const channel = yield* ChannelClient.connect(
        wsUrl,
        { "x-zcode-rpc-host-capability": capability },
        {
          onRequest: handlers.onRequest,
          // Issue #5 state invalidation: a channel close first drops the
          // cached connection metadata, then reaches the app handler — but
          // only for the channel that is still current (a late close from a
          // superseded channel is ignored).
          onClose: onChannelClosed(channelGen),
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

    const onChannelClosed =
      (channelGen: number) =>
      (reason: string): Effect.Effect<void, E> =>
        Effect.gen(function* () {
          const currentGen = yield* Ref.get(channelGenRef);
          if (currentGen !== channelGen) {
            // A reconnect (or dispose) already moved past this channel — its
            // late close must not invalidate the fresh connection state.
            yield* log.debug(`[session] ignored close of superseded channel gen ${channelGen} (${reason})`);
            return;
          }
          yield* invalidateConnection;
          yield* log.debug(`[session] channel closed (${reason}) — cached connection invalidated`);
          yield* handlers.onClosed(reason);
        });

    /**
     * Best-effort replays after a fresh channel: `initialize` is per-channel
     * daemon state (the project itself persists across daemon restarts, so
     * the cached workspace/project id stays valid), and the conversation
     * subscription must be re-registered on the new channel so streamed rows
     * and turn completions keep flowing to the Client.
     */
    const replayAfterReconnect = (channel: ChannelClient<E>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const workspace = yield* Ref.get(workspaceRef);
        if (Option.isSome(workspace)) {
          yield* tolerate(channel.call("zcode-agent", "initialize", workspace.value, 30_000), (cause) =>
            log.debug(`[session] post-reconnect initialize failed (continuing): ${renderError(cause)}`),
          );
        }
        const session = yield* Ref.get(sessionRef);
        if (Option.isSome(session)) {
          const mcpServers = yield* Ref.get(mcpServersRef);
          if (Option.isSome(mcpServers) && mcpServers.value.length > 0) {
            yield* tolerate(
              channel.call(
                "zcode-session",
                "resumeSession",
                {
                  sessionId: session.value.daemonSessionId,
                  workspace: {
                    workspacePath: session.value.workspace.workspacePath,
                    workspaceIdentity: session.value.workspace.workspaceIdentity,
                  },
                  mcpServers: mcpServers.value,
                },
                30_000,
              ),
              (cause) => log.debug(`[session] post-reconnect resumeSession failed (continuing): ${renderError(cause)}`),
            );
          }
          yield* tolerate(
            subscribeConversation(session.value.daemonSessionId, session.value.workspace, channel),
            (cause) => log.debug(`[session] post-reconnect subscribe failed: ${renderError(cause)}`),
          );
        }
      });

    /**
     * Lazy reconnection on a bounded budget (issue #5): invalidate, then re-run
     * the attach workflow up to RECOVERY_ATTEMPTS times. If the Daemon stays
     * unreachable, fail fast — the Bridge exits non-zero so the Client's own
     * runtime recovery restarts it (a -32000 reply would only read as a
     * provider failure). Never fails typed: exhaustion is the exit.
     */
    const reconnectChannel: Effect.Effect<ChannelClient<E>> = Effect.gen(function* () {
      const staleEpoch = yield* Ref.get(connectionEpoch);
      return yield* reconnectPermit.withPermit(
        Effect.gen(function* () {
          // Another fiber may have finished a reconnection while this caller
          // waited on the permit — adopt its channel instead of dialing
          // again. Without the epoch bump the check would adopt the very
          // channel this caller just deemed stale.
          const currentEpoch = yield* Ref.get(connectionEpoch);
          const adopted = yield* Ref.get(channelRef);
          if (currentEpoch !== staleEpoch && Option.isSome(adopted) && !adopted.value.isSettled) {
            return adopted.value;
          }
          yield* invalidateConnection;
          for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS; attempt += 1) {
            const outcome = yield* Effect.result(connectChannel);
            if (Result.isSuccess(outcome)) {
              yield* replayAfterReconnect(outcome.success);
              yield* log.debug(`[session] channel re-established (attempt ${attempt}/${RECOVERY_ATTEMPTS})`);
              return outcome.success;
            }
            yield* log.warn(
              `[session] reconnect attempt ${attempt}/${RECOVERY_ATTEMPTS} failed: ${renderError(outcome.failure)}`,
            );
            if (attempt < RECOVERY_ATTEMPTS) yield* Effect.sleep(RECOVERY_RETRY_DELAY);
          }
          return yield* bridgeExit.exit(`zcode daemon unreachable after ${RECOVERY_ATTEMPTS} reconnect attempts`);
        }),
      );
    });

    const getChannel: Effect.Effect<ChannelClient<E>, ServeError> = Effect.gen(function* () {
      const existing = yield* Ref.get(channelRef);
      if (Option.isSome(existing)) {
        const channel = existing.value;
        // Watchdog (issue #5): a settled channel is never reused, and the
        // memoized connection is dropped when the local status file reports a
        // different or unready daemon.
        const connection = yield* Ref.get(connectionRef);
        if (!channel.isSettled && Option.isSome(connection) && (yield* connectionStillValid(connection.value))) {
          return channel;
        }
        return yield* reconnectChannel;
      }
      // No cached channel. With a live daemon session this IS a reconnection
      // (a close already invalidated the cache), so the bounded recovery
      // budget applies; before the first createSession it is a plain first
      // attach whose failure surfaces as a typed error to the caller.
      const session = yield* Ref.get(sessionRef);
      if (Option.isSome(session)) return yield* reconnectChannel;
      return yield* connectChannel;
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

    // Listener disposers (from channel.listen). The disposer never fails — the
    // channel swallows its own write failures inside it — so dispose drains
    // them bare, with no per-disposer error handling.
    const listenerDisposers: Array<Effect.Effect<void>> = [];

    const subscribeConversation = (
      daemonSessionId: string,
      workspace: WorkspaceInfo,
      channel: ChannelClient<E>,
    ): Effect.Effect<void, ServeError> =>
      Effect.gen(function* () {
        if ((yield* Ref.get(subscribedRef)) === true) return;
        yield* Ref.set(subscribedRef, true);
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

        // Both subscriptions share the same daemon arg and the same
        // register-on-subscribe / drain-on-dispose lifecycle; only the event
        // name, the workspace-wide filter, and the handler differ.
        const registerListener = (
          event: string,
          keep: (payload: unknown) => boolean,
          onEvent: (payload: unknown) => Effect.Effect<void, E>,
        ): Effect.Effect<void, ServeError> =>
          Effect.gen(function* () {
            const disposer = yield* channel.listen(
              "zcode-agent",
              event,
              {
                sessionId: daemonSessionId,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              },
              (payload) => (keep(payload) ? onEvent(payload) : Effect.void),
            );
            listenerDisposers.push(disposer);
          });

        const topic = `conversation/${daemonSessionId}`;
        const extractFrameTopic = (p: unknown): string | undefined => {
          const rec = p as { topic?: string; frame?: { topic?: string } } | undefined;
          return rec?.frame?.topic ?? rec?.topic;
        };
        const extractChildSessionId = (topicStr: string | undefined): string | undefined => {
          if (typeof topicStr === "string" && topicStr.startsWith("conversation/")) {
            return topicStr.slice("conversation/".length);
          }
          return undefined;
        };

        // The daemon pushes workspace-wide frames: every v4/conversation/frame
        // notification it receives is fired into the per-workspace emitter
        // (server-core.js 3.19.0:62503-62539), so frames of child conversations
        // arrive on this same listener once their topic is subscribed (see
        // subscribeChild below; host pattern — subscribe visibility
        // "background" + topic filter — :66885). Route here: parent (or
        // topic-less) → onConversationFrame, subscribed child → onChildFrame,
        // everything else dropped (same client-side filter as the upstream
        // adapter).
        yield* registerListener(
          "onDynamicConversationFrame",
          (payload) => {
            const frameTopic = extractFrameTopic(payload);
            if (frameTopic === undefined || frameTopic === topic) return true;
            const childId = extractChildSessionId(frameTopic);
            return childId !== undefined && childTopics.has(childId);
          },
          (payload) => {
            const frameTopic = extractFrameTopic(payload);
            if (frameTopic === undefined || frameTopic === topic) return handlers.onConversationFrame(payload);
            const childId = extractChildSessionId(frameTopic);
            if (childId !== undefined && childTopics.has(childId)) return handlers.onChildFrame(childId, payload);
            return Effect.void;
          },
        );
        yield* registerListener(
          "onDynamicSessionLifecycle",
          (payload) => {
            const lifecycleSessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
            return lifecycleSessionId === undefined || lifecycleSessionId === daemonSessionId;
          },
          handlers.onLifecycle,
        );
      });

    const requireDaemonSession: Effect.Effect<{ daemonSessionId: string; workspace: WorkspaceInfo }, SessionError> =
      Effect.gen(function* () {
        const session = yield* Ref.get(sessionRef);
        if (Option.isNone(session)) {
          return yield* new SessionError({ message: "no daemon session — call createSession first" });
        }
        return session.value;
      });

    const createSession: ServeSession["createSession"] = (modelSelection, mcpServers) =>
      Effect.gen(function* () {
        const workspace = yield* ensureWorkspace;
        const arg: Record<string, unknown> = {
          projectId: workspace.projectId,
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
        };
        if (modelSelection !== undefined && modelSelection !== null) arg.model = modelSelection;
        if (mcpServers !== undefined && mcpServers.length > 0) {
          const daemonMcpServers = mcpServers.map(toDaemonMcpServer);
          arg.mcpServers = daemonMcpServers;
          yield* Ref.set(mcpServersRef, Option.some(daemonMcpServers));
        }
        const result = yield* callSession("createSession", arg, 150_000);
        const decoded = decodeCreateSession(result);
        if (decoded === undefined) {
          return yield* new SessionError({
            message: `createSession returned no sessionId: ${JSON.stringify(result).slice(0, 400)}`,
          });
        }
        yield* Ref.set(sessionRef, Option.some({ daemonSessionId: decoded.daemonSessionId, workspace }));
        const channel = yield* getChannel;
        yield* Effect.forkDetach(
          tolerate(subscribeConversation(decoded.daemonSessionId, workspace, channel), (cause) =>
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

    const setMcpServers: ServeSession["setMcpServers"] = (mcpServers) =>
      Effect.gen(function* () {
        const daemonMcpServers = mcpServers.map(toDaemonMcpServer);
        yield* Ref.set(mcpServersRef, daemonMcpServers.length > 0 ? Option.some(daemonMcpServers) : Option.none());
        const session = yield* Ref.get(sessionRef);
        if (Option.isSome(session)) {
          yield* tolerate(
            callSession(
              "resumeSession",
              {
                sessionId: session.value.daemonSessionId,
                workspace: {
                  workspacePath: session.value.workspace.workspacePath,
                  workspaceIdentity: session.value.workspace.workspaceIdentity,
                },
                mcpServers: daemonMcpServers,
              },
              30_000,
            ),
            (cause) => log.debug(`[session] resumeSession with mcpServers failed: ${renderError(cause)}`),
          );
        }
      });

    /**
     * Pre-flight liveness probe before dispatching a Turn (issue #5): a
     * sub-second round-trip on the channel catches silent half-open sockets
     * that never fired an OS-level close event, so the prompt goes out on a
     * channel that just answered us instead of dying with a -32000 error.
     * Probe failure triggers the bounded reconnection — which either lands a
     * fresh channel or exits the Bridge (never fails typed).
     */
    const preflight: Effect.Effect<void, ServeError> = Effect.gen(function* () {
      const channel = yield* getChannel;
      const probe = yield* Effect.result(
        channel.call("zcode-agent", "helloConversationV4", undefined, PROBE_TIMEOUT_MS),
      );
      if (Result.isSuccess(probe)) return;
      yield* log.warn(
        `[session] pre-flight probe failed (${renderError(probe.failure)}) — reconnecting before dispatch`,
      );
      yield* reconnectChannel;
    });

    const sendPrompt: ServeSession["sendPrompt"] = (text, modelSelection, attachments) =>
      Effect.gen(function* () {
        const { daemonSessionId, workspace } = yield* requireDaemonSession;
        yield* preflight;
        const inputId = crypto.randomUUID();
        yield* call(
          "sendPrompt",
          {
            sessionId: daemonSessionId,
            inputId,
            content: text,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
            ...(modelSelection !== undefined && modelSelection.modelId !== "" ? { modelSelection } : {}),
          },
          60_000,
        );
        return { inputId };
      });

    const resolveInteraction: ServeSession["resolveInteraction"] = (interactionId, answer) =>
      Effect.gen(function* () {
        const { daemonSessionId, workspace } = yield* requireDaemonSession;
        return yield* call(
          "sendConversationCommandV4",
          {
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
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
        const { daemonSessionId, workspace } = yield* requireDaemonSession;
        yield* call(
          "setMode",
          {
            sessionId: daemonSessionId,
            mode,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          },
          30_000,
        );
      });

    const sendCommand: ServeSession["sendCommand"] = (type, payload, expectedForegroundExecutionId) =>
      Effect.gen(function* () {
        const { daemonSessionId, workspace } = yield* requireDaemonSession;
        return yield* call(
          "sendConversationCommandV4",
          {
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
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

    const listSubagents = (endedLimit = 20): Effect.Effect<SubagentsSnapshot, ServeError> =>
      Effect.gen(function* () {
        const { daemonSessionId, workspace } = yield* requireDaemonSession;
        const result = yield* call(
          "listSessionSubagents",
          {
            sessionId: daemonSessionId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            endedLimit,
          },
          15_000,
        );
        const decoded = decodeSubagents(result);
        if (decoded === undefined) {
          return yield* new SessionError({
            message: `listSessionSubagents returned no snapshot: ${JSON.stringify(result).slice(0, 400)}`,
          });
        }
        return decoded;
      });

    const subscribeChild = (childSessionId: string): Effect.Effect<void, ServeError> =>
      Effect.gen(function* () {
        if (childTopics.has(childSessionId) || inFlightSubscribes.has(childSessionId)) return;
        inFlightSubscribes.add(childSessionId);
        try {
          const { workspace } = yield* requireDaemonSession;
          const channel = yield* getChannel;
          yield* channel.call(
            "zcode-agent",
            "subscribeConversationV4",
            {
              sessionId: childSessionId,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
              visibility: "background",
            },
            30_000,
          );
          if (cancelledSubscribes.has(childSessionId)) {
            cancelledSubscribes.delete(childSessionId);
            yield* channel.call(
              "zcode-agent",
              "unsubscribeConversationV4",
              {
                sessionId: childSessionId,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              },
              15_000,
            );
            return;
          }
          childTopics.add(childSessionId);
          yield* log.debug(`[session] subscribed child conversation ${childSessionId}`);
        } finally {
          inFlightSubscribes.delete(childSessionId);
        }
      });

    const unsubscribeChild = (childSessionId: string): Effect.Effect<void> =>
      tolerate(
        Effect.gen(function* () {
          if (inFlightSubscribes.has(childSessionId)) {
            cancelledSubscribes.add(childSessionId);
          }
          if (!childTopics.has(childSessionId)) return;
          childTopics.delete(childSessionId);
          cancelledSubscribes.delete(childSessionId);
          const { workspace } = yield* requireDaemonSession;
          const channel = yield* getChannel;
          // unsubscribeConversationV4 resolves the remembered route from the
          // sessionId/workspace args (server-core.js 3.19.0:62069) — no
          // subscriptionId to carry.
          yield* channel.call(
            "zcode-agent",
            "unsubscribeConversationV4",
            {
              sessionId: childSessionId,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
            },
            15_000,
          );
          yield* log.debug(`[session] unsubscribed child conversation ${childSessionId}`);
        }),
        (cause) => log.debug(`[session] unsubscribe child ${childSessionId} skipped: ${renderError(cause)}`),
      );

    // Best-effort teardown, run by the `dispose` property on session/unload.
    // Every step swallows its own failure — listener disposers never fail (the
    // channel's writes inside them are already tolerated), the channel close
    // can fail only with the app-supplied `onClose` channel `E` (warned here,
    // not propagated), and the scope close is total — so dispose's error
    // channel is `never` for every instantiation of `E`.
    const dispose: Effect.Effect<void> = Effect.gen(function* () {
      for (const childId of [...childTopics]) {
        yield* unsubscribeChild(childId);
      }
      for (const disposer of listenerDisposers.splice(0)) {
        yield* disposer;
      }
      const channel = yield* Ref.get(channelRef);
      if (Option.isSome(channel)) {
        yield* tolerate(channel.value.close(), (cause) =>
          log.warn(`[session] channel close failed during dispose: ${renderError(cause)}`),
        );
      }
      // Scope.close never fails typed (Effect<void>) — no fallback needed.
      yield* ScopeType.close(scope, Exit.succeed(undefined));
    });

    return {
      createSession,
      setMcpServers,
      sendPrompt,
      resolveInteraction,
      setMode,
      sendCommand,
      listSubagents,
      subscribeChild,
      unsubscribeChild,
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

const SubagentEntryShape = Schema.Struct({
  childSessionId: Schema.String,
  subagentType: Schema.String,
  status: Schema.String,
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
});
const decodeSubagentEntryShape = Schema.decodeUnknownOption(SubagentEntryShape);

const SubagentsSnapshotShape = Schema.Struct({
  revision: Schema.optional(Schema.Finite),
  childSessionIds: Schema.optional(Schema.Array(Schema.String)),
  running: Schema.optional(Schema.Array(Schema.Unknown)),
  ended: Schema.optional(
    Schema.Struct({
      total: Schema.optional(Schema.Finite),
      items: Schema.optional(Schema.Array(Schema.Unknown)),
      nextCursor: Schema.optional(Schema.String),
    }),
  ),
});
const decodeSubagentsSnapshotShape = Schema.decodeUnknownOption(SubagentsSnapshotShape);

/**
 * Tolerant `session/subagents` decode — the result arrives as
 * `{ revision, childSessionIds, running[], ended: { total, items, nextCursor? }
 * }` (see SubagentsSnapshot provenance). Entries missing any of childSessionId
 * / subagentType / status are dropped; everything else is taken when it has
 * the right primitive type, conforming to Schema decoding.
 */
const decodeSubagents = (result: unknown): SubagentsSnapshot | undefined => {
  const opt = decodeSubagentsSnapshotShape(result);
  if (Option.isNone(opt)) return undefined;
  const r = opt.value;
  const parseEntries = (arr: readonly unknown[] | undefined): SubagentEntry[] => {
    if (!Array.isArray(arr)) return [];
    const entries: SubagentEntry[] = [];
    for (const item of arr) {
      const entryOpt = decodeSubagentEntryShape(item);
      if (Option.isSome(entryOpt)) {
        const val = entryOpt.value;
        entries.push({
          childSessionId: val.childSessionId,
          subagentType: val.subagentType,
          status: val.status,
          ...(val.toolCallId !== undefined ? { toolCallId: val.toolCallId } : {}),
          ...(val.title !== undefined ? { title: val.title } : {}),
          ...(val.summary !== undefined ? { summary: val.summary } : {}),
        });
      }
    }
    return entries;
  };
  return {
    revision: r.revision ?? 0,
    running: parseEntries(r.running),
    ended: {
      total: r.ended?.total ?? 0,
      items: parseEntries(r.ended?.items),
    },
  };
};

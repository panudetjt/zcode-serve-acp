/**
 * Session layer over the daemon channel — mirrors the owner's PR #34713
 * adapter (zcodeServeConnection.ts): project resolution by cwd, workspace
 * initialize, createSession (models come from the daemon), subscribe
 * foreground conversation frames, sendPrompt, interaction resolution.
 *
 * Channel names: "zcode-session" (createSession) and "zcode-agent"
 * (initialize, subscribeConversationV4, sendPrompt, sendConversationCommandV4,
 * readSession, setMode, resolveInteraction …).
 */
import { ChannelClient } from "./channel.ts";
import type { DaemonConnection } from "./daemon.ts";

const CREATE_TIMEOUT_MS = 150_000;
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

export interface ServeEvents {
  onConversationFrame: (payload: unknown) => void;
  onLifecycle: (payload: unknown) => void;
  /** daemon → client request (e.g. interaction requests) — return the answer */
  onRequest: (channelName: string, name: string, arg: unknown) => Promise<unknown>;
  onClosed?: (reason: string) => void;
  log?: (...parts: unknown[]) => void;
}

interface WorkspaceInfo {
  workspacePath: string;
  workspaceIdentity: string;
  projectId: string;
}

export class ServeSession {
  private channel: ChannelClient | null = null;
  private workspace: WorkspaceInfo | null = null;
  private daemonSessionId: string | null = null;
  private conversationSubscribed = false;
  /** Current reasoning effort (from daemon default or client config_option). */
  thoughtLevel: string | undefined = undefined;
  readonly log: (...parts: unknown[]) => void;

  constructor(
    private readonly daemon: DaemonConnection,
    private readonly cwd: string,
    private readonly events: ServeEvents,
  ) {
    this.log = events.log ?? (() => {});
  }

  private async ensureChannel(): Promise<ChannelClient> {
    if (this.channel) return this.channel;
    const capability = await this.daemon.getCapability(); // 30s TTL, single use
    const wsUrl = `ws://${this.daemon.status.host}:${this.daemon.status.port}${this.daemon.wsPath}` +
      (this.daemon.token ? `?token=${encodeURIComponent(this.daemon.token)}` : "");
    this.channel = new ChannelClient({
      url: wsUrl,
      headers: { "x-zcode-rpc-host-capability": capability },
      onRequest: async (channelName, name, arg) => this.events.onRequest(channelName, name, arg),
      onClose: (reason) => this.events.onClosed?.(reason),
      log: this.log,
    });
    await this.channel.ready();
    this.log?.(`[session] channel ready ${wsUrl.replace(/token=[^&]*/, "token=…")}`);
    return this.channel;
  }

  private async call<T>(method: string, arg?: unknown, timeoutMs = 30_000): Promise<T> {
    const channel = await this.ensureChannel();
    this.log?.(`[session] call zcode-agent.${method}`);
    return channel.call<T>("zcode-agent", method, arg, timeoutMs);
  }

  private async callSession<T>(method: string, arg?: unknown, timeoutMs = 30_000): Promise<T> {
    const channel = await this.ensureChannel();
    this.log?.(`[session] call zcode-session.${method}`);
    return channel.call<T>("zcode-session", method, arg, timeoutMs);
  }

  /** Resolve (or mint) the daemon project matching this bridge's cwd, then workspace-initialize. */
  async ensureWorkspace(): Promise<WorkspaceInfo> {
    if (this.workspace) return this.workspace;
    const channel = await this.ensureChannel();
    const identity = { rootPath: this.cwd };
    let projectId: string | undefined;
    try {
      // Repeated attaches do not mint duplicate projects — the daemon dedupes by rootPath.
      const saved = (await channel.call<unknown>(
        "project",
        "saveProject",
        { roots: [this.cwd] },
        30_000,
      )) as unknown;
      const savedRec = saved as { id?: string; project?: { id?: string }; result?: { id?: string } } | string | undefined;
      projectId =
        typeof savedRec === "string"
          ? savedRec
          : (savedRec?.id ?? savedRec?.project?.id ?? savedRec?.result?.id);
      this.log?.(`[session] saveProject → ${projectId} (${JSON.stringify(saved)?.slice(0, 200)})`);
    } catch (error) {
      this.log?.(`[session] saveProject failed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (projectId === undefined) {
      throw new Error(`cannot resolve a zcode server project for ${this.cwd}`);
    }
    this.workspace = { workspacePath: this.cwd, workspaceIdentity: this.cwd, projectId };
    // Workspace initialize — the adapter ignores failures with a warning.
    try {
      const init = await channel.call<unknown>("zcode-agent", "initialize", this.workspace, 30_000);
      this.log?.(`[session] zcode-agent.initialize →`, JSON.stringify(init)?.slice(0, 200));
    } catch (error) {
      this.log?.(
        `[session] zcode-agent.initialize failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.workspace;
  }

  async createSession(modelSelection?: unknown): Promise<CreateSessionResult> {
    const workspace = await this.ensureWorkspace();
    const arg: Record<string, unknown> = {
      projectId: workspace.projectId,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    };
    if (modelSelection !== undefined && modelSelection !== null) arg.model = modelSelection;
    const result = await this.callSession<Record<string, unknown>>(
      "createSession",
      arg,
      CREATE_TIMEOUT_MS,
    );
    this.log?.(`[session] createSession keys: ${Object.keys(result ?? {}).join(",")}`);
    const daemonSessionId =
      (result?.sessionId as string | undefined) ??
      (result?.session as { sessionId?: string } | undefined)?.sessionId ??
      (result?.id as string | undefined);
    if (!daemonSessionId) {
      throw new Error(`createSession returned no sessionId: ${JSON.stringify(result).slice(0, 400)}`);
    }
    this.daemonSessionId = daemonSessionId;
    const settings = (result?.settings ?? {}) as {
      model?: {
        current?: { ref?: { providerId?: string; modelId?: string }; options?: { reasoningLevel?: string } };
        available?: Array<{
          ref?: { providerId?: string; modelId?: string };
          label?: string;
          providerLabel?: string;
          contextWindow?: number;
          reasoning?: { levels?: Array<{ value: string; label?: string }>; defaultLevel?: string };
        }>;
      };
    };
    const models: AvailableModel[] = (settings.model?.available ?? [])
      .map((m) => ({
        providerId: m.ref?.providerId ?? "",
        modelId: m.ref?.modelId ?? "",
        label: m.label,
        providerLabel: m.providerLabel,
        contextWindow: m.contextWindow,
        reasoningLevels: m.reasoning?.levels?.map((l) => ({ value: l.value, label: l.label ?? l.value })),
        reasoningDefaultLevel: m.reasoning?.defaultLevel,
      }))
      .filter((m) => m.modelId !== "");
    const currentRef = settings.model?.current;
    const current =
      currentRef?.ref?.providerId && currentRef?.ref?.modelId
        ? `${currentRef.ref.providerId}/${currentRef.ref.modelId}`
        : currentRef?.ref?.modelId;
    if (currentRef?.options?.reasoningLevel !== undefined) {
      this.thoughtLevel = currentRef.options.reasoningLevel;
    }
    void this.subscribeConversation(daemonSessionId);
    const rawSlash = Array.isArray(result?.slashCommands) ? (result.slashCommands as Array<{ name?: string; description?: string }>) : [];
    const slashCommands = rawSlash
      .filter((c) => typeof c?.name === "string" && c.name !== "")
      .map((c) => ({ name: c.name as string, description: c.description }));
    const currentMode = (result?.session as { mode?: string } | undefined)?.mode;
    let skills: DiscoveredSkill[] = [];
    try {
      const channel = await this.ensureChannel();
      const skillsResult = await channel.call<{
        skills?: Array<{ name?: string; description?: string; path?: string; enabled?: boolean }>;
      }>(
        "skills",
        "list",
        { workspacePath: workspace.workspacePath, workspaceIdentity: workspace.workspaceIdentity },
        5000,
      );
      skills = (skillsResult?.skills ?? [])
        .filter((s) => s.enabled !== false && typeof s.name === "string" && s.name.trim() !== "")
        .map((s) => ({
          name: s.name!.trim(),
          ...(s.description ? { description: s.description.trim() } : {}),
          ...(s.path ? { path: s.path } : {}),
        }));
      this.log?.(`[session] discovered ${skills.length} skills from daemon`);
    } catch (error) {
      this.log?.(`[session] skills.list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { daemonSessionId, models, currentModel: current, currentMode, slashCommands, skills, raw: result };
  }

  private async subscribeConversation(daemonSessionId: string): Promise<void> {
    if (this.conversationSubscribed) return;
    this.conversationSubscribed = true;
    const channel = await this.ensureChannel();
    try {
      await channel.call(
        "zcode-agent",
        "subscribeConversationV4",
        {
          sessionId: daemonSessionId,
          workspacePath: this.workspace?.workspacePath ?? this.cwd,
          workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd,
          visibility: "foreground",
        },
        30_000,
      );
      this.log?.(`[session] subscribed conversation ${daemonSessionId}`);
    } catch (error) {
      this.log?.(
        `[session] subscribeConversationV4 failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const topic = `conversation/${daemonSessionId}`;
    channel.listen(
      "zcode-agent",
      "onDynamicConversationFrame",
      { sessionId: daemonSessionId, workspacePath: this.workspace?.workspacePath ?? this.cwd, workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd },
      (payload) => {
        // The daemon pushes workspace-wide frames — filter to OUR conversation
        // (client-side filtering, same as the upstream adapter).
        const frameTopic =
          (payload as { topic?: string; frame?: { topic?: string } })?.frame?.topic ??
          (payload as { topic?: string })?.topic;
        if (frameTopic !== undefined && frameTopic !== topic) return;
        this.events.onConversationFrame(payload);
      },
    );
    channel.listen(
      "zcode-agent",
      "onDynamicSessionLifecycle",
      { sessionId: daemonSessionId, workspacePath: this.workspace?.workspacePath ?? this.cwd, workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd },
      (payload) => {
        const lifecycleSessionId = (payload as { sessionId?: string })?.sessionId;
        if (lifecycleSessionId !== undefined && lifecycleSessionId !== daemonSessionId) return;
        this.events.onLifecycle(payload);
      },
    );
  }

  async sendPrompt(
    text: string,
    modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } },
    attachments?: PromptAttachment[],
  ): Promise<{ inputId: string }> {
    if (this.daemonSessionId === null) throw new Error("no daemon session — call createSession first");
    const inputId = crypto.randomUUID();
    await this.call(
      "sendPrompt",
      {
        sessionId: this.daemonSessionId,
        inputId,
        content: text,
        workspacePath: this.workspace?.workspacePath ?? this.cwd,
        workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd,
        ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
        ...(modelSelection !== undefined && modelSelection.modelId !== ""
          ? { modelSelection }
          : {}),
      },
      60_000,
    );
    return { inputId };
  }

  async resolveInteraction(interactionId: string, answer: unknown): Promise<unknown> {
    if (this.daemonSessionId === null) throw new Error("no daemon session");
    return this.call(
      "sendConversationCommandV4",
      {
        workspacePath: this.workspace?.workspacePath ?? this.cwd,
        workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd,
        envelope: {
          commandId: crypto.randomUUID(),
          clientId: CLIENT_ID,
          sessionId: this.daemonSessionId,
          type: "resolveInteraction",
          payload: {
            interactionId,
            answer,
          },
          issuedAt: Date.now(),
        },
      },
      30_000,
    );
  }

  async setMode(mode: string): Promise<void> {
    if (this.daemonSessionId === null) throw new Error("no daemon session");
    await this.call(
      "setMode",
      {
        sessionId: this.daemonSessionId,
        mode,
        workspacePath: this.workspace?.workspacePath ?? this.cwd,
        workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd,
      },
      30_000,
    );
  }

  async sendCommand(type: string, payload: unknown, expectedForegroundExecutionId?: string): Promise<unknown> {
    if (this.daemonSessionId === null) throw new Error("no daemon session");
    return this.call(
      "sendConversationCommandV4",
      {
        workspacePath: this.workspace?.workspacePath ?? this.cwd,
        workspaceIdentity: this.workspace?.workspaceIdentity ?? this.cwd,
        envelope: {
          commandId: crypto.randomUUID(),
          clientId: CLIENT_ID,
          sessionId: this.daemonSessionId,
          type,
          payload,
          ...(expectedForegroundExecutionId !== undefined ? { expectedForegroundExecutionId } : {}),
          issuedAt: Date.now(),
        },
      },
      30_000,
    );
  }
}

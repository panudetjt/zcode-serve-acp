/**
 * ACP server (Agent Client Protocol, newline-delimited JSON-RPC over stdio).
 *
 * MVP surface: initialize · session/new (models advertised from the daemon) ·
 * session/prompt (streaming session/update) · session/request_permission ·
 * session/set_mode · session/set_model · session/cancel. Resume/compact/load
 * are phase 2.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { connectDaemon, type DaemonConnection } from "../serve/daemon.ts";
import { ServeSession, type AvailableModel, type DiscoveredSkill, type PromptAttachment } from "../serve/session.ts";
import { FrameTranslator, classifyToolKind, type TurnUsage, type PendingInteraction } from "../translate.ts";
import { fallbackModels, modelsToAcp } from "../models.ts";

const DEBUG = process.env.ZCODE_SERVE_ACP_DEBUG === "1";
const log = (...parts: unknown[]) => {
  if (DEBUG) console.error("[acp]", ...parts);
};

interface BridgeSession {
  serve: ServeSession;
  translator: FrameTranslator;
  models: AvailableModel[];
  skills: DiscoveredSkill[];
  modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
  thoughtLevel?: string;
  currentMode?: string;
  quietTimer?: Timer;
  lastUsage?: TurnUsage;
  handledInteractions?: Set<string>;
  pendingTurn?: {
    resolve: (stopReason: string) => void;
    reject: (error: Error) => void;
    timer?: Timer;
    sawUpdate: boolean;
  };
}

const MODES = ["plan", "build", "edit", "guarded", "yolo"] as const;

/**
 * Session configOptions per the ACP client contract (the zcode-acp
 * CONFIG-OPTIONS guide t3code follows): `model` select (values
 * `providerId\modelId`), `mode` select, and `thought` select (category
 * `thought_level` — what t3code renders as the Effort panel).
 */
function buildConfigOptions(bridge: BridgeSession): unknown[] {
  const models = bridge.models;
  const sel = bridge.modelSelection;
  const currentModel =
    models.find((m) => m.providerId === sel?.providerId && m.modelId === sel?.modelId) ?? models[0];
  const currentValue = currentModel ? `${currentModel.providerId}/${currentModel.modelId}` : undefined;
  const thoughtLevels = currentModel?.reasoningLevels ?? [];
  const thoughtCurrent =
    bridge.thoughtLevel ?? currentModel?.reasoningDefaultLevel ?? thoughtLevels[0]?.value ?? "max";
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    ...(currentValue !== undefined ? { currentValue } : {}),
    options: models.map((m) => ({
      value: `${m.providerId}/${m.modelId}`,
      name: m.providerLabel ? `${m.label ?? m.modelId} (${m.providerLabel})` : (m.label ?? m.modelId),
      ...(m.providerLabel ? { description: m.providerLabel } : {}),
    })),
  };
  const modeOption = {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    // REQUIRED by the ACP session-config schema — a select without currentValue
    // fails the whole configOptions parse on the client.
    currentValue: bridge.currentMode ?? MODES[1],
    options: MODES.map((m) => ({ value: m, name: m.charAt(0).toUpperCase() + m.slice(1) })),
  };
  const thoughtOption =
    thoughtLevels.length > 0
      ? {
          // id "reasoning" is in t3code's known effort-id list (works across app
          // builds); category thought_level marks it as the effort selector.
          id: "reasoning",
          name: "Thinking Level",
          category: "thought_level",
          type: "select",
          currentValue: thoughtCurrent,
          options: thoughtLevels.map((l) => ({
            value: l.value,
            name: l.label ? l.label.charAt(0).toUpperCase() + l.label.slice(1) : l.value,
          })),
        }
      : undefined;
  return [modelOption, modeOption, ...(thoughtOption !== undefined ? [thoughtOption] : [])];
}

export class AcpServer {
  private daemon: DaemonConnection | null = null;
  private sessions = new Map<string, BridgeSession>();

  constructor(private readonly emitNotification: (method: string, params: unknown) => void) {}

  private async ensureDaemon(): Promise<DaemonConnection> {
    if (this.daemon === null) this.daemon = await connectDaemon(process.env, log);
    return this.daemon;
  }

  private endTurn(sessionId: string, reason: string, stopReason = "end_turn"): void {
    const s = this.sessions.get(sessionId);
    if (s?.pendingTurn === undefined) return;
    if (DEBUG) console.error(`[acp] endTurn(${reason}) from:`, new Error().stack?.split("\n").slice(1, 5).join(" | "));
    if (s.quietTimer !== undefined) {
      clearTimeout(s.quietTimer);
      s.quietTimer = undefined;
    }
    if (s.pendingTurn.timer !== undefined) {
      clearTimeout(s.pendingTurn.timer);
      s.pendingTurn.timer = undefined;
    }
    const resolve = s.pendingTurn.resolve;
    s.pendingTurn = undefined;
    if (DEBUG) console.error(`[acp] turn end (${reason}) — translator unknowns: ${s.translator.debugSummary()}`);
    resolve(reason === "cancelled" ? "cancelled" : stopReason);
  }

  private failTurn(sessionId: string, error: Error): void {
    const s = this.sessions.get(sessionId);
    if (s?.pendingTurn === undefined) return;
    if (DEBUG) console.error(`[acp] failTurn:`, error.message);
    if (s.quietTimer !== undefined) {
      clearTimeout(s.quietTimer);
      s.quietTimer = undefined;
    }
    if (s.pendingTurn.timer !== undefined) {
      clearTimeout(s.pendingTurn.timer);
      s.pendingTurn.timer = undefined;
    }
    const reject = s.pendingTurn.reject;
    s.pendingTurn = undefined;
    reject(error);
  }

  private async handlePendingInteraction(sessionId: string, interaction: PendingInteraction): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.handledInteractions?.has(interaction.interactionId)) return;
    if (!s.handledInteractions) s.handledInteractions = new Set();
    s.handledInteractions.add(interaction.interactionId);

    log(`[interaction] pending interaction ${interaction.interactionId} (kind=${interaction.kind})`);
    const rawPayload = (interaction.payload ?? {}) as Record<string, unknown>;

    const isElicitation =
      interaction.kind === "userInput" ||
      interaction.kind === "elicitation" ||
      rawPayload.kind === "userInput" ||
      rawPayload.kind === "elicitation" ||
      rawPayload.toolName === "AskUserQuestion" ||
      rawPayload.toolName === "ExitPlanMode" ||
      (Array.isArray(rawPayload.questions) && rawPayload.questions.length > 0) ||
      (Boolean(rawPayload.input) &&
        typeof rawPayload.input === "object" &&
        Array.isArray((rawPayload.input as Record<string, unknown>).questions));

    if (isElicitation) {
      await this.handleElicitationInteraction(s, sessionId, interaction, rawPayload);
    } else {
      await this.handlePermissionInteraction(s, sessionId, interaction, rawPayload);
    }
  }

  private async handleElicitationInteraction(
    s: BridgeSession,
    sessionId: string,
    interaction: PendingInteraction,
    rawPayload: Record<string, unknown>,
  ): Promise<void> {
    log(`[interaction] routing to elicitation/create for ${interaction.interactionId}`);

    interface ExtractedQuestion {
      id: string;
      header: string;
      question: string;
      options: Array<{ value: string; label: string; description?: string }>;
      multiSelect?: boolean;
    }

    let questions: ExtractedQuestion[] = [];
    const rawInput = (rawPayload.input ?? {}) as Record<string, unknown>;

    const sourceQuestions =
      Array.isArray(rawPayload.questions) && rawPayload.questions.length > 0
        ? rawPayload.questions
        : Array.isArray(rawInput.questions) && (rawInput.questions as unknown[]).length > 0
        ? (rawInput.questions as unknown[])
        : undefined;

    if (sourceQuestions) {
      questions = sourceQuestions.map((q, idx) => {
        const qRec = (q ?? {}) as Record<string, unknown>;
        const header = String(qRec.header ?? qRec.title ?? `Question ${idx + 1}`);
        const questionText = String(qRec.question ?? qRec.prompt ?? rawPayload.prompt ?? "Please choose an option:");
        const rawOpts = Array.isArray(qRec.options) ? qRec.options : [];
        const options = rawOpts.map((opt, oIdx) => {
          const oRec = (opt ?? {}) as Record<string, unknown>;
          const label = String(oRec.label ?? oRec.name ?? oRec.value ?? `Option ${oIdx + 1}`);
          const value = String(oRec.value ?? oRec.optionId ?? label);
          const description = oRec.description ? String(oRec.description) : undefined;
          return { value, label, description };
        });
        return {
          id: `q${idx}`,
          header,
          question: questionText,
          options,
          multiSelect: Boolean(qRec.multiSelect),
        };
      });
    } else if (rawPayload.toolName === "ExitPlanMode") {
      const plan = typeof rawInput.plan === "string" ? rawInput.plan.trim() : "";
      questions = [
        {
          id: "q0",
          header: "Plan",
          question: plan ? `Review this implementation plan:\n\n${plan}` : "Review this implementation plan.",
          options: [
            { value: "approve", label: "Approve", description: "Exit plan mode and start implementation." },
            { value: "reject", label: "Reject", description: "Stay in plan mode." },
          ],
          multiSelect: false,
        },
      ];
    } else if (Array.isArray(rawPayload.options) && rawPayload.options.length > 0) {
      questions = [
        {
          id: "q0",
          header: "Question",
          question: String(rawPayload.prompt ?? rawPayload.summary ?? "Please select an option:"),
          options: (rawPayload.options as Array<Record<string, unknown>>).map((opt, oIdx) => {
            const label = String(opt.label ?? opt.name ?? opt.optionId ?? `Option ${oIdx + 1}`);
            const value = String(opt.optionId ?? opt.value ?? label);
            const description = opt.description ? String(opt.description) : undefined;
            return { value, label, description };
          }),
          multiSelect: false,
        },
      ];
    } else {
      questions = [
        {
          id: "q0",
          header: "Question",
          question: String(rawPayload.prompt ?? rawPayload.summary ?? "Please provide input:"),
          options: [],
          multiSelect: false,
        },
      ];
    }

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const q of questions) {
      required.push(q.id);
      if (q.options.length > 0) {
        if (q.multiSelect) {
          properties[q.id] = {
            type: "array",
            title: q.header,
            description: q.question,
            items: {
              anyOf: q.options.map((opt) => ({
                const: opt.value,
                title: opt.label,
                description: opt.description ?? opt.label,
              })),
            },
          };
        } else {
          properties[q.id] = {
            type: "string",
            title: q.header,
            description: q.question,
            oneOf: q.options.map((opt) => ({
              const: opt.value,
              title: opt.label,
              description: opt.description ?? opt.label,
            })),
          };
        }
      } else {
        properties[q.id] = {
          type: "string",
          title: q.header,
          description: q.question,
        };
      }
    }

    const message = questions[0]?.question ?? String(rawPayload.prompt ?? "Input required");
    const elicitationParams = {
      sessionId,
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties,
        required,
      },
      ...(rawPayload.toolCallId ? { toolCallId: String(rawPayload.toolCallId) } : {}),
    };

    try {
      log(`[interaction] requesting elicitation/create from client:`, JSON.stringify(elicitationParams));
      const answer = (await this.clientRequest("elicitation/create", elicitationParams)) as {
        action?: string;
        content?: Record<string, unknown>;
      } | null;

      log(`[interaction] elicitation response received:`, JSON.stringify(answer));
      const action = answer?.action ?? "accept";

      if (action === "accept") {
        const content = answer?.content ?? {};
        // Match chosenOptionId if possible from the first question's options
        const firstAns = content[questions[0]?.id ?? "q0"] ?? Object.values(content)[0];
        let chosenOptionId: string | undefined;
        if (questions[0]?.options.length) {
          const matched = questions[0].options.find(
            (o) => o.value === firstAns || o.label === firstAns
          );
          chosenOptionId = matched?.value ?? (typeof firstAns === "string" ? firstAns : undefined);
        } else if (typeof firstAns === "string") {
          chosenOptionId = firstAns;
        }

        const resolvePayload = {
          action: "accept",
          content,
          ...(chosenOptionId ? { optionId: chosenOptionId } : {}),
        };
        log(`[interaction] resolving elicitation ${interaction.interactionId} with:`, JSON.stringify(resolvePayload));
        await s.serve.resolveInteraction(interaction.interactionId, resolvePayload);
      } else {
        const resolvePayload = {
          action: action === "decline" ? "decline" : "cancel",
          optionId: "deny",
        };
        log(`[interaction] resolving declined/cancelled elicitation ${interaction.interactionId} with:`, JSON.stringify(resolvePayload));
        await s.serve.resolveInteraction(interaction.interactionId, resolvePayload);
      }
    } catch (err) {
      log(`[interaction] elicitation/create threw:`, err);
      try {
        await s.serve.resolveInteraction(interaction.interactionId, {
          action: "cancel",
          optionId: "deny",
        });
      } catch (e) {
        log(`[interaction] fallback cancel resolution failed:`, e);
      }
    }
  }

  private async handlePermissionInteraction(
    s: BridgeSession,
    sessionId: string,
    interaction: PendingInteraction,
    rawPayload: Record<string, unknown>,
  ): Promise<void> {
    const rawOptions = (rawPayload.options as Array<Record<string, unknown>>) ?? [];
    const options = rawOptions.map((o, i) => {
      const kindStr = String(o.kind ?? "").toLowerCase();
      let kind = "allow_once";
      if (kindStr.includes("always") && !kindStr.includes("deny") && !kindStr.includes("reject")) {
        kind = "allow_always";
      } else if (kindStr.includes("deny") || kindStr.includes("reject")) {
        kind = kindStr.includes("always") ? "reject_always" : "reject_once";
      } else if (i === rawOptions.length - 1 && rawOptions.length > 1) {
        kind = "reject_once";
      }
      return {
        optionId: String(o.optionId ?? `opt_${i}`),
        name: String(o.label ?? o.name ?? o.optionId ?? `Option ${i + 1}`),
        kind,
      };
    });

    const toolCallId = String(
      rawPayload.toolCallId ??
      s.translator.getLatestActiveToolCallId() ??
      `tool_${randomUUID().slice(0, 8)}`
    );
    const toolKind = classifyToolKind(rawPayload.toolName as string | undefined);
    const permissionParams = {
      sessionId,
      toolCall: {
        toolCallId,
        title: (rawPayload.summary as string) ?? (rawPayload.toolName as string) ?? "Command execution",
        kind: toolKind,
      },
      options: options.length > 0 ? options : [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" }
      ],
    };

    try {
      log(`[interaction] requesting permission from client for ${toolCallId}`);
      const answer = await this.clientRequest(`session/request_permission`, permissionParams);
      const outcomeObj = (answer as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
      let chosenOptionId: string | undefined;
      if (outcomeObj) {
        if (outcomeObj.outcome === "selected") {
          chosenOptionId = outcomeObj.optionId;
        } else if (outcomeObj.outcome === "denied" || outcomeObj.outcome === "cancelled") {
          const denyOpt = rawOptions.find(
            (o) => String(o.kind ?? "").toLowerCase().includes("deny") || String(o.optionId ?? "").toLowerCase().includes("deny")
          );
          chosenOptionId = (denyOpt?.optionId as string) ?? "deny";
        }
      }
      if (!chosenOptionId) {
        chosenOptionId = (answer as { optionId?: string })?.optionId;
      }
      if (!chosenOptionId && options.length > 0) {
        chosenOptionId = options[0].optionId;
      }
      log(`[interaction] resolving ${interaction.interactionId} with optionId=${chosenOptionId}`);
      await s.serve.resolveInteraction(interaction.interactionId, { optionId: chosenOptionId });
    } catch (err) {
      log(`[interaction] request_permission threw:`, err);
      const fallbackOpt = (rawOptions[0]?.optionId as string) ?? "allow";
      try {
        await s.serve.resolveInteraction(interaction.interactionId, { optionId: fallbackOpt });
      } catch (e) {
        log(`[interaction] fallback resolution failed:`, e);
      }
    }
  }

  private makeServeSession(cwd: string, daemon: DaemonConnection, explicitSessionId?: string): { id: string; bridge: BridgeSession } {
    const sessionId = explicitSessionId || randomUUID();
    const translator = new FrameTranslator((...parts) => log(...parts));
    const session: BridgeSession = {
      serve: null as never,
      translator,
      models: [],
      skills: [],
      handledInteractions: new Set<string>(),
    };
    const serve = new ServeSession(
      daemon,
      cwd,
      {
        onConversationFrame: (payload) => {
          log(`[frame] in:`, JSON.stringify(payload).slice(0, 160));
          const { updates, turnComplete, assistantSettled, hasActiveWork, turnFailed, turnCancelled, errorMessage, usage, pendingInteractions } =
            translator.fold(payload);
          if (usage !== undefined) {
            session.lastUsage = usage;
          }
          if (session.pendingTurn !== undefined) {
            session.pendingTurn.sawUpdate = true;
            // Clear initial response timer as daemon is responsive and producing frames
            if (session.pendingTurn.timer !== undefined) {
              clearTimeout(session.pendingTurn.timer);
              session.pendingTurn.timer = undefined;
            }
          }
          for (const u of updates) {
            log(`[frame] emit ${u.sessionUpdate}`);
            this.emitNotification(`session/update`, { sessionId, update: u });
          }
          if (pendingInteractions && pendingInteractions.length > 0) {
            for (const interaction of pendingInteractions) {
              void this.handlePendingInteraction(sessionId, interaction);
            }
          }
          if (turnFailed) {
            this.failTurn(sessionId, new Error(errorMessage ?? "Turn execution failed in daemon"));
            return;
          }
          if (turnCancelled) {
            this.endTurn(sessionId, "turn cancelled", "cancelled");
            return;
          }
          if (turnComplete) {
            this.endTurn(sessionId, "turn complete");
            return;
          }
          if (hasActiveWork && session.quietTimer !== undefined) {
            // Tools, subagents, or turnHeader are actively running — do NOT end the turn!
            clearTimeout(session.quietTimer);
            session.quietTimer = undefined;
          } else if (assistantSettled && !hasActiveWork) {
            // Assistant row settled and no active work/tools/subagents and phase is not running — fallback quiet window (5s)
            if (session.quietTimer !== undefined) clearTimeout(session.quietTimer);
            session.quietTimer = setTimeout(() => this.endTurn(sessionId, "assistant settled + quiet"), 5_000);
            return;
          }
          if (updates.length > 0 && session.quietTimer !== undefined) {
            clearTimeout(session.quietTimer);
            session.quietTimer = undefined;
          }
        },
        onLifecycle: (payload) => {
          const raw = JSON.stringify(payload);
          log(`[lifecycle]`, raw.slice(0, 300));
          const p = payload as {
            state?: string;
            lastError?: { message?: string; code?: string } | null;
            error?: string;
          };
          if (p.state === "faulted" || p.lastError) {
            const msg = p.lastError?.message || p.error || "daemon session faulted";
            this.failTurn(sessionId, new Error(`Daemon error: ${msg}`));
            return;
          }
          if (p.state === "stopping" || p.state === "unloaded") {
            this.endTurn(sessionId, `session state ${p.state}`);
          }
        },
        onRequest: async (channelName, name, arg) => {
          log(`[server-request] ${channelName}.${name}:`, JSON.stringify(arg)?.slice(0, 500));
          if (name.toLowerCase().includes("permission")) {
            const rawArg = (arg ?? {}) as {
              interactionId?: string;
              toolCallId?: string;
              toolName?: string;
              options?: Array<{ id?: string; optionId?: string; name?: string; kind?: string }>;
            };
            const options = (rawArg.options ?? []).map((o, i) => {
              const kindStr = String(o.kind ?? "").toLowerCase();
              let kind = "allow_once";
              if (kindStr.includes("always") && !kindStr.includes("reject") && !kindStr.includes("deny")) {
                kind = "allow_always";
              } else if (kindStr.includes("deny") || kindStr.includes("reject")) {
                kind = kindStr.includes("always") ? "reject_always" : "reject_once";
              } else if (i === (rawArg.options?.length ?? 0) - 1 && (rawArg.options?.length ?? 0) > 1) {
                kind = "reject_once";
              }
              return {
                optionId: String(o.optionId ?? o.id ?? `opt_${i}`),
                name: String(o.name ?? o.optionId ?? `option ${i}`),
                kind,
              };
            });
            const toolCallId = String(
              rawArg.toolCallId ??
              session.translator.getLatestActiveToolCallId() ??
              `tool_${randomUUID().slice(0, 8)}`
            );
            const toolKind = classifyToolKind(rawArg.toolName);
            const permissionParams = {
              sessionId,
              toolCall: {
                toolCallId,
                title: rawArg.toolName ?? "Command",
                kind: toolKind,
              },
              options: options.length > 0 ? options : [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" }
              ],
            };
            try {
              const answer = await this.clientRequest(`session/request_permission`, permissionParams);
              const outcomeObj = (answer as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
              let chosenOptionId: string | undefined;
              if (outcomeObj) {
                if (outcomeObj.outcome === "selected") {
                  chosenOptionId = outcomeObj.optionId;
                } else if (outcomeObj.outcome === "denied" || outcomeObj.outcome === "cancelled") {
                  const denyOpt = rawArg.options?.find(
                    (o) => String(o.kind ?? "").includes("deny") || String(o.optionId ?? o.id).includes("deny")
                  );
                  chosenOptionId = denyOpt ? String(denyOpt.optionId ?? denyOpt.id) : "deny";
                }
              }
              if (!chosenOptionId) {
                chosenOptionId = (answer as { optionId?: string })?.optionId;
              }
              if (!chosenOptionId) {
                chosenOptionId = options[0]?.optionId ?? "allow";
              }
              const daemonOption = rawArg.options?.find((o) => String(o.optionId ?? o.id) === chosenOptionId);
              const resolved = rawArg.interactionId !== undefined
                ? { interactionId: rawArg.interactionId, answer: daemonOption ?? { optionId: chosenOptionId } }
                : { answer: daemonOption ?? { optionId: chosenOptionId } };
              return resolved;
            } catch (err) {
              log(`[server-request] request_permission threw:`, err);
              const allowOpt = rawArg.options?.[0];
              return rawArg.interactionId !== undefined
                ? { interactionId: rawArg.interactionId, answer: allowOpt ?? { optionId: "allow" } }
                : { answer: allowOpt ?? { optionId: "allow" } };
            }
          }
          // Unknown server request — acknowledge with empty object (logged above).
          return {};
        },
        onClosed: (reason) => {
          const s = this.sessions.get(sessionId);
          if (s?.pendingTurn && !s.pendingTurn.sawUpdate) {
            this.failTurn(sessionId, new Error(`Connection closed before response: ${reason}`));
          } else {
            this.endTurn(sessionId, `channel closed: ${reason}`);
          }
        },
        log,
      },
    );
    session.serve = serve;
    this.sessions.set(sessionId, session);
    return { id: sessionId, bridge: session };
  }

  /** Called by bin.ts once the daemon connection is established per session. */
  async handle(method: string, params: Record<string, unknown>, clientRequest: (m: string, p: unknown) => Promise<unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        return {
          protocolVersion: 1,
          agentInfo: { name: "zcode-serve-acp", title: "ZCode (serve daemon)", version: "0.1.0" },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: {
              resume: {},
            },
            promptCapabilities: { audio: false, embeddedContext: false, image: true },
          },
          authMethods: [
            { id: "zcode-cli-login", name: "ZCode CLI login (owned by the zcode serve daemon)", description: "Run `zcode login` once; the daemon reads credentials itself." },
          ],
        };
      }
      case "auth/authenticate": {
        // The daemon owns credentials — nothing to do.
        return {};
      }
      case "session/load":
      case "session/resume":
      case "session/new": {
        const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : process.cwd();
        const existingId = typeof params.sessionId === "string" && params.sessionId !== "" ? params.sessionId : undefined;
        let bridge = existingId ? this.sessions.get(existingId) : undefined;
        let sessionId = existingId ?? randomUUID();
        if (bridge === undefined) {
          const daemon = await this.ensureDaemon();
          const createdSession = this.makeServeSession(cwd, daemon, sessionId);
          sessionId = createdSession.id;
          bridge = createdSession.bridge;
          const created = await bridge.serve.createSession();
          let models = created.models;
          let current = created.currentModel;
          if (models.length === 0) {
            log(`[${method}] daemon advertised no models — falling back to catalog+presence (#33684 extraction)`);
            const fb = fallbackModels();
            models = fb.models;
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
          log(`[${method}] daemon=${created.daemonSessionId} models=${modelsAcp.availableModels.map((m) => m.modelId).join(", ")} skills=${bridge.skills.length}`);
          const availableCommands = [
            ...(created.slashCommands ?? []).map((c) => ({
              name: c.name,
              ...(c.description !== undefined ? { description: c.description } : {}),
            })),
            ...(created.skills ?? []).map((s) => ({
              name: `$${s.name}`,
              ...(s.description !== undefined ? { description: s.description } : {}),
            })),
          ];
          this.emitNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands,
            },
          });
          const rawProj = (created.raw as { projection?: { contextUsed?: number; contextWindow?: number } } | undefined)?.projection;
          const initialUsed = rawProj?.contextUsed ?? 0;
          const initialSize = currentModel?.contextWindow ?? rawProj?.contextWindow ?? 200_000;
          this.emitNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: initialUsed,
              size: initialSize,
            },
          });
          return {
            sessionId,
            models: modelsAcp,
            configOptions: buildConfigOptions(bridge),
            _meta: { t3SessionLoadReady: "replay_idle" },
          };
        }
        return {
          sessionId,
          models: modelsToAcp(
            bridge.models,
            bridge.modelSelection ? `${bridge.modelSelection.providerId}/${bridge.modelSelection.modelId}` : undefined
          ),
          configOptions: buildConfigOptions(bridge),
          _meta: { t3SessionLoadReady: "replay_idle" },
        };
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId ?? "");
        const bridge = this.sessions.get(sessionId);
        if (bridge === undefined) throw new Error(`unknown session ${sessionId}`);
        const blocks = Array.isArray(params.prompt) ? params.prompt : [];
        const text = blocks
          .map((b) => (typeof b === "string" ? b : (((b as Record<string, unknown>).text as string | undefined) ?? "")))
          .join("\n");
        const attachments: PromptAttachment[] = [];
        for (const b of blocks) {
          if (typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "image") {
            const img = b as { type: "image"; data?: string; mimeType?: string; uri?: string };
            const mimeType = img.mimeType || "image/png";
            const ext = mimeType.split("/")[1] || "png";
            attachments.push({
              kind: "image",
              filename: `image_${attachments.length + 1}.${ext}`,
              mimeType,
              ...(img.data ? { dataBase64: img.data } : {}),
              ...(img.uri && img.uri.startsWith("file://") ? { localPath: img.uri.replace("file://", "") } : {}),
            });
          }
        }
        // If the user triggered a skill via T3 Code's /skill:<name> syntax, format it with
        // the skill's file link so the ZCode daemon recognizes it as a skill mention.
        const skillMatch = /^\/skill:([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        let promptPayload = text;
        if (skillMatch) {
          const skillName = skillMatch[1];
          const userArg = skillMatch[2]?.trim() ?? "";
          const found = bridge.skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
          if (found?.path) {
            promptPayload = `[$${found.name}](${found.path})${userArg ? ` ${userArg}` : ""}`;
          } else if (found) {
            promptPayload = `[$${found.name}]${userArg ? ` ${userArg}` : ""}`;
          }
        }
        const modelSelection = bridge.modelSelection
          ? {
              providerId: bridge.modelSelection.providerId,
              modelId: bridge.modelSelection.modelId,
              ...(bridge.thoughtLevel !== undefined ? { options: { reasoningLevel: bridge.thoughtLevel } } : {}),
            }
          : undefined;
        bridge.handledInteractions?.clear();
        bridge.translator.startTurn();
        await bridge.serve.sendPrompt(
          promptPayload,
          modelSelection,
          attachments.length > 0 ? attachments : undefined,
        );
        const stopReason = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            log(`[prompt] initial response timeout (no response from daemon within 180s)`);
            reject(new Error("Turn timed out: no response received from daemon within 180 seconds"));
          }, 180_000);
          bridge.pendingTurn = { resolve, reject, timer, sawUpdate: false };
        });
        log(`[prompt] turn promise resolved (${stopReason})`);
        return {
          stopReason,
          ...(bridge.lastUsage !== undefined ? { usage: bridge.lastUsage } : {}),
        };
      }
      case "session/set_model": {
        const sessionId = String(params.sessionId ?? "");
        const bridge = this.sessions.get(sessionId);
        if (bridge === undefined) throw new Error(`unknown session ${sessionId}`);
        const modelId = String((params.modelId as string) ?? "");
        const slash = Math.max(modelId.lastIndexOf("/"), modelId.lastIndexOf("\\"));
        bridge.modelSelection =
          slash >= 0
            ? { providerId: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) }
            : { providerId: "", modelId };
        const model = bridge.models.find(
          (m) => m.providerId === bridge.modelSelection?.providerId && m.modelId === bridge.modelSelection?.modelId
        );
        if (model?.reasoningDefaultLevel) {
          bridge.thoughtLevel = model.reasoningDefaultLevel;
        }
        const options = buildConfigOptions(bridge);
        this.emitNotification("session/update", {
          sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: options },
        });
        const newSize = model?.contextWindow ?? 200_000;
        this.emitNotification("session/update", {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: bridge.lastUsage ? (bridge.lastUsage.inputTokens + bridge.lastUsage.outputTokens) : 0,
            size: newSize,
          },
        });
        return { configOptions: options };
      }
      case "session/set_config_option": {
        // t3code sends {sessionId, configId, value} (SetSessionConfigOptionRequest);
        // the response MUST carry the updated configOptions array.
        const sessionId = String(params.sessionId ?? "");
        const bridge = this.sessions.get(sessionId);
        if (bridge === undefined) throw new Error(`unknown session ${sessionId}`);
        const optionId = String(params.configId ?? params.configOptionId ?? params.id ?? "");
        const value = String(params.value ?? params.currentValue ?? "");
        log(`[config] set ${optionId} = ${value}`);
        if (optionId === "model") {
          const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
          bridge.modelSelection =
            slash >= 0
              ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
              : { providerId: "", modelId: value };
          const model = bridge.models.find(
            (m) => m.providerId === bridge.modelSelection?.providerId && m.modelId === bridge.modelSelection?.modelId
          );
          if (model?.reasoningDefaultLevel) {
            bridge.thoughtLevel = model.reasoningDefaultLevel;
          }
          const options = buildConfigOptions(bridge);
          this.emitNotification("session/update", {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: options },
          });
          const newSize = model?.contextWindow ?? 200_000;
          this.emitNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: bridge.lastUsage ? (bridge.lastUsage.inputTokens + bridge.lastUsage.outputTokens) : 0,
              size: newSize,
            },
          });
          return { configOptions: options };
        }
        if (
          optionId === "thought" ||
          optionId === "reasoning" ||
          optionId === "thinking_level" ||
          optionId === "thinking"
        ) {
          bridge.thoughtLevel = value;
          const options = buildConfigOptions(bridge);
          this.emitNotification("session/update", {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: options },
          });
          return { configOptions: options };
        }
        if (optionId === "mode") {
          try {
            await bridge.serve.setMode(value);
          } catch (error) {
            log(`[config] setMode failed:`, error instanceof Error ? error.message : String(error));
          }
          bridge.currentMode = value;
          const options = buildConfigOptions(bridge);
          this.emitNotification("session/update", {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: options },
          });
          return { configOptions: options };
        }
        throw new Error(`unknown config option ${optionId}`);
      }
      case "session/set_mode": {
        const sessionId = String(params.sessionId ?? "");
        const bridge = this.sessions.get(sessionId);
        if (bridge === undefined) throw new Error(`unknown session ${sessionId}`);
        const modeId = String((params.modeId as string) ?? "");
        try {
          await bridge.serve.setMode(modeId);
        } catch (error) {
          log(`[session/set_mode] failed:`, error instanceof Error ? error.message : String(error));
        }
        bridge.currentMode = modeId;
        return {};
      }
      case "session/cancel": {
        const sessionId = String(params.sessionId ?? "");
        const bridge = this.sessions.get(sessionId);
        if (bridge === undefined) return {};
        try {
          await bridge.serve.sendCommand("stop", {});
        } catch (error) {
          log(`[cancel] stop rejected:`, error instanceof Error ? error.message : String(error));
        }
        this.endTurn(sessionId, "cancelled");
        return {};
      }
      default:
        throw new Error(`unsupported ACP method ${method}`);
    }
  }

  /** ACP client→server request handle, injected by bin.ts (used for permission asks). */
  clientRequest: (method: string, params: unknown) => Promise<unknown> = async () => {
    throw new Error("client request channel not wired");
  };
}

/** Helper for bin.ts: keep sessions map access for prompt-session binding. */
export function createAcpServer(emitNotification: (method: string, params: unknown) => void): AcpServer {
  return new AcpServer(emitNotification);
}

// readline helper re-export for bin.ts
export function stdinLines(onLine: (line: string) => void): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed !== "") onLine(trimmed);
  });
}

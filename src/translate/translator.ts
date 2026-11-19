/**
 * Daemon conversation frames → ACP `session/update` notifications.
 *
 * Ported behavior-identical from the pre-rewrite FrameTranslator; the parity
 * gate is test/golden-replay.test.ts against fixtures captured from a real
 * daemon (runtime 3.18.2, wireVersion 3, captured 19 พ.ย. 2026).
 *
 * Frame shape (ground-truthed):
 *   payload: { kind: "deltas", deltas: [
 *     { op: "state.updated", patch: {...} },
 *     { op: "row.appended" | "row.upserted" | "row.updated",
 *       row: { rowId, kind, text, state, … } },
 *     { op: "row.delta", rowId, path, append } ] }
 * plus up to three envelope nestings the daemon has been observed to use
 * ({frame:{payload}}, {payload}, bare {deltas}) and snapshots carrying
 * pendingInteractions.
 *
 * `assistant`/`reasoning` rows carry the ACCUMULATED text on every upsert —
 * the translator diffs per rowId so ACP receives only the new suffix.
 *
 * NOTE: unlike the stable RPC/status/ACP boundaries (which go through
 * `Schema`), row/delta shapes are probed with typed guards here ON PURPOSE —
 * the daemon overloads these shapes and the pre-rewrite per-field `typeof`
 * guards are the working spec; the golden fixtures encode the outcomes.
 */
import { classifyToolKind, normalizeStatus } from "./toolKind.ts";

export interface ToolCallContentItem {
  type: "content" | "diff" | "terminal";
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
  _meta?: unknown;
}

export interface AcpUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string } | ToolCallContentItem[];
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string }>;
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string } | null;
  _meta?: unknown;
}

export interface TurnUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

export interface PendingInteractionOption {
  optionId?: string;
  value?: string;
  label?: string;
  name?: string;
  description?: string;
  kind?: string;
}

export interface PendingInteractionQuestion {
  question?: string;
  header?: string;
  title?: string;
  prompt?: string;
  options?: PendingInteractionOption[];
  multiSelect?: boolean;
  freeText?: boolean;
}

export interface PendingInteraction {
  interactionId: string;
  kind: string;
  anchorRowId?: number | null;
  payload?: {
    kind?: string;
    prompt?: string;
    summary?: string;
    freeText?: boolean;
    sensitive?: boolean;
    questions?: PendingInteractionQuestion[];
    options?: PendingInteractionOption[];
    toolCallId?: string;
    toolName?: string;
    detail?: unknown;
    input?: unknown;
    schema?: unknown;
  };
}

export interface FoldResult {
  updates: AcpUpdate[];
  turnComplete: boolean;
  assistantSettled: boolean;
  hasActiveWork: boolean;
  turnFailed: boolean;
  turnCancelled?: boolean;
  errorMessage?: string;
  usage?: TurnUsage;
  pendingInteractions?: PendingInteraction[];
}

// ---------- typed unknown access (replaces `as Record<string, unknown>`) ----------

type Rec = Record<string, unknown>;

const rec = (value: unknown): Rec | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;

const str = (r: Rec | undefined, key: string): string | undefined => {
  const v = r?.[key];
  return typeof v === "string" ? v : undefined;
};

const num = (r: Rec | undefined, key: string): number | undefined => {
  const v = r?.[key];
  return typeof v === "number" ? v : undefined;
};

const bool = (r: Rec | undefined, key: string): boolean | undefined => {
  const v = r?.[key];
  return typeof v === "boolean" ? v : undefined;
};

const arr = (r: Rec | undefined, key: string): unknown[] | undefined => {
  const v = r?.[key];
  return Array.isArray(v) ? v : undefined;
};

const recAt = (r: Rec | undefined, key: string): Rec | undefined => rec(r?.[key]);

interface Row {
  readonly rowId: number;
  readonly kind: string;
  readonly raw: Rec;
}

const readRow = (value: unknown): Row | undefined => {
  const r = rec(value);
  if (r === undefined) return undefined;
  const rowId = num(r, "rowId");
  const kind = str(r, "kind");
  if (rowId === undefined || kind === undefined) return undefined;
  return { rowId, kind, raw: r };
};

interface DeltaEnvelope {
  readonly deltas: unknown[];
  readonly snapshot: Rec | undefined;
  readonly rawError: unknown;
}

/**
 * Unwrap the daemon's observed envelope nestings, preserving the exact
 * precedence of the pre-rewrite translator:
 *   error  ← frame.payload.error ?? frame.payload.failure ?? payload.error ??
 *            payload.failure ?? envelope.error ?? envelope.failure
 *   inner  ← frame.payload ?? payload ?? (bare deltas)
 *   snap   ← inner.snapshot ?? envelope.snapshot ?? frame.payload.snapshot ??
 *            payload.snapshot
 */
function unwrapEnvelope(payload: unknown): DeltaEnvelope | undefined {
  const envelope = rec(payload);
  if (envelope === undefined) return undefined;
  const frame = recAt(envelope, "frame");
  const framePayload = recAt(frame, "payload");
  const payloadPayload = recAt(envelope, "payload");
  const bareDeltas = arr(envelope, "deltas");

  const rawError =
    framePayload?.["error"] ??
    framePayload?.["failure"] ??
    payloadPayload?.["error"] ??
    payloadPayload?.["failure"] ??
    envelope["error"] ??
    envelope["failure"];

  const inner: Rec | undefined =
    framePayload ?? payloadPayload ?? (bareDeltas !== undefined ? { deltas: bareDeltas } : undefined);
  if (inner === undefined) return { deltas: [], snapshot: undefined, rawError };

  const innerSnapshot = recAt(inner, "snapshot");
  const snapshot =
    innerSnapshot ??
    recAt(envelope, "snapshot") ??
    recAt(framePayload, "snapshot") ??
    recAt(payloadPayload, "snapshot");

  const innerKind = str(inner, "kind");
  const deltas = innerKind === "deltas" ? (arr(inner, "deltas") ?? []) : [];
  return { deltas, snapshot, rawError };
}

const readErrorMessage = (raw: unknown): string => {
  if (typeof raw === "string") return raw;
  const r = rec(raw);
  const message = str(r, "message");
  if (message !== undefined) return message;
  try {
    return JSON.stringify(raw);
  } catch {
    return "unknown daemon error";
  }
};

interface StatePatch {
  readonly control: Rec | undefined;
  readonly pendingInteractions: unknown[] | undefined;
  readonly usage: Rec | undefined;
}

const readPatch = (delta: unknown): StatePatch | undefined => {
  const r = rec(delta);
  const patch = recAt(r, "patch");
  if (patch === undefined) return undefined;
  return {
    control: recAt(patch, "control"),
    pendingInteractions: arr(patch, "pendingInteractions"),
    usage: recAt(patch, "usage"),
  };
};

interface ToolRow {
  status: string | undefined;
  state: string | undefined;
  title: string | undefined;
  toolName: string | undefined;
  name: string | undefined;
  toolCallId: string | undefined;
  inputText: string | undefined;
  input: unknown;
  output: Rec | undefined;
  outputPreview: Rec | undefined;
  error: Rec | undefined;
  backgrounded: boolean | undefined;
  workId: string | undefined;
  approvalInteractionId: string | undefined;
  progressPreviewLine: string | undefined;
}

const readToolRow = (row: Row): ToolRow => ({
  status: str(row.raw, "status"),
  state: str(row.raw, "state"),
  title: str(row.raw, "title"),
  toolName: str(row.raw, "toolName") ?? str(row.raw, "name"),
  name: str(row.raw, "name"),
  toolCallId: str(row.raw, "toolCallId"),
  inputText: str(row.raw, "inputText"),
  input: row.raw["input"],
  output: recAt(row.raw, "output"),
  outputPreview: recAt(row.raw, "outputPreview"),
  error: recAt(row.raw, "error"),
  backgrounded: bool(row.raw, "backgrounded"),
  workId: str(row.raw, "workId"),
  approvalInteractionId: str(row.raw, "approvalInteractionId"),
  progressPreviewLine: str(recAt(row.raw, "progress"), "previewLine"),
});

export function classifyRowKind(toolName?: string): string {
  return classifyToolKind(toolName);
}

interface ToolInfo {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: string;
}

const DEBUG = process.env.ZCODE_SERVE_ACP_DEBUG === "1";

export class FrameTranslator {
  private rowText = new Map<number, string>();
  private rowKind = new Map<number, string>();
  private rowTool = new Map<number, ToolInfo>();
  private toolOutput = new Map<number, string>();
  private unknownOps = new Map<string, number>();
  private unknownKinds = new Map<string, number>();
  private turnHeaderState?: string;
  private turnPhase?: string;
  private activeItemIds = new Set<number>();
  private activeWorksCount = 0;
  private pendingInteractionsCount = 0;

  constructor(private readonly log: (...parts: unknown[]) => void) {}

  startTurn(): void {
    this.turnPhase = "running";
    this.turnHeaderState = "running";
    this.activeWorksCount = 1;
    this.pendingInteractionsCount = 0;
    this.activeItemIds.clear();
    this.toolOutput.clear();
  }

  getLatestActiveToolCallId(): string | undefined {
    const lastId = Array.from(this.activeItemIds).pop();
    if (lastId !== undefined) {
      return this.rowTool.get(lastId)?.toolCallId;
    }
    const allTools = Array.from(this.rowTool.values());
    return allTools.pop()?.toolCallId;
  }

  hasActiveWork(): boolean {
    return (
      this.activeItemIds.size > 0 ||
      this.turnPhase === "running" ||
      this.turnPhase === "prewarming" ||
      this.turnHeaderState === "running" ||
      this.activeWorksCount > 0 ||
      this.pendingInteractionsCount > 0
    );
  }

  debugSummary(): string {
    return `ops=${[...this.unknownOps.entries()].map(([k, v]) => `${k}×${v}`).join(",") || "-"} kinds=${
      [...this.unknownKinds.entries()].map(([k, v]) => `${k}×${v}`).join(",") || "-"
    }`;
  }

  /** Fold one daemon frame payload; returns ACP updates + turn lifecycle flags. */
  fold(payload: unknown): FoldResult {
    let turnComplete = false;
    let assistantSettled = false;
    let turnFailed = false;
    let turnCancelled = false;
    let errorMessage: string | undefined;
    let usage: TurnUsage | undefined;
    const updates: AcpUpdate[] = [];
    const pendingInteractions: PendingInteraction[] = [];

    const envelope = unwrapEnvelope(payload);
    if (envelope !== undefined) {
      if (envelope.rawError !== undefined && envelope.rawError !== null) {
        turnComplete = true;
        turnFailed = true;
        errorMessage = readErrorMessage(envelope.rawError);
      }
      const snapshotPending = arr(envelope.snapshot, "pendingInteractions");
      if (snapshotPending !== undefined) {
        this.pendingInteractionsCount = snapshotPending.length;
        for (const item of snapshotPending) {
          const interaction = readPendingInteraction(item);
          if (interaction !== undefined) pendingInteractions.push(interaction);
        }
      }
    }

    const deltas = envelope?.deltas ?? [];
    if (deltas.length === 0) {
      return this.result(updates, {
        turnComplete,
        assistantSettled,
        turnFailed,
        turnCancelled,
        errorMessage,
        usage,
        pendingInteractions,
      });
    }

    // Pre-register row kinds from all deltas in this batch
    for (const delta of deltas) {
      const row = readRow(recAt(rec(delta), "row"));
      if (row !== undefined) this.rowKind.set(row.rowId, row.kind);
    }

    for (const delta of deltas) {
      const op = str(rec(delta), "op");

      if (op === "state.updated") {
        const patch = readPatch(delta);
        if (patch === undefined) continue;
        const control = patch.control;

        const lastError =
          control !== undefined && control["lastError"] !== undefined && control["lastError"] !== null
            ? rec(control["lastError"])
            : undefined;
        if (lastError !== undefined) {
          turnComplete = true;
          turnFailed = true;
          this.turnPhase = undefined;
          this.activeWorksCount = 0;
          this.pendingInteractionsCount = 0;
          errorMessage = str(lastError, "message") ?? `Daemon error: ${str(lastError, "code") ?? "?"}`;
        }

        const activeWorks = control?.["activeWorks"];
        if (activeWorks !== undefined) {
          this.activeWorksCount = Array.isArray(activeWorks) ? activeWorks.length : 0;
        }

        const patchPending = patch.pendingInteractions;
        if (patchPending !== undefined) {
          this.pendingInteractionsCount = patchPending.length;
          for (const item of patchPending) {
            const interaction = readPendingInteraction(item);
            if (interaction !== undefined) pendingInteractions.push(interaction);
          }
        }

        const phase = control !== undefined ? str(control, "phase") : undefined;
        if (phase !== undefined) {
          this.turnPhase = phase;
          if (phase === "completedSuccess") {
            turnComplete = true;
            this.turnPhase = undefined;
            this.turnHeaderState = undefined;
            this.activeWorksCount = 0;
            this.pendingInteractionsCount = 0;
          } else if (phase === "completedInterrupted") {
            turnComplete = true;
            turnCancelled = true;
            this.turnPhase = undefined;
            this.turnHeaderState = undefined;
            this.activeWorksCount = 0;
            this.pendingInteractionsCount = 0;
          } else if (phase === "error") {
            turnComplete = true;
            turnFailed = true;
            this.turnPhase = undefined;
            this.turnHeaderState = undefined;
            this.activeWorksCount = 0;
            this.pendingInteractionsCount = 0;
            errorMessage =
              (control !== undefined ? str(recAt(control, "lastError"), "message") : undefined) ??
              "Turn execution failed in daemon";
          } else if (phase === "running" || phase === "prewarming") {
            this.turnPhase = "running";
          }
        }

        const stopState = control !== undefined ? str(control, "stopState") : undefined;
        const sessionEnded = control !== undefined ? bool(control, "sessionEnded") : undefined;
        if (stopState === "stopping" || (sessionEnded === true && this.activeWorksCount === 0)) {
          turnComplete = true;
          this.turnPhase = undefined;
          this.turnHeaderState = undefined;
          this.activeWorksCount = 0;
        }

        if (patch.usage !== undefined) {
          const contextWindow = recAt(patch.usage, "contextWindow");
          const used = num(contextWindow, "usedTokens");
          const size = num(contextWindow, "maxTokens");
          if (used !== undefined && size !== undefined && size > 0) {
            updates.push({ sessionUpdate: "usage_update", used, size });
          }
          const cum = recAt(patch.usage, "cumulative");
          if (cum !== undefined) {
            const inTok = num(cum, "inputTokens") ?? 0;
            const outTok = num(cum, "outputTokens") ?? 0;
            usage = {
              totalTokens: inTok + outTok,
              inputTokens: inTok,
              outputTokens: outTok,
              cachedReadTokens: num(cum, "cacheReadTokens") ?? 0,
              cachedWriteTokens: num(cum, "cacheWriteTokens") ?? 0,
            };
          }
        }
        continue;
      }

      if (op === "row.delta") {
        const d = rec(delta);
        const rowId = num(d, "rowId") ?? -1;
        const appendText = str(d, "append") ?? "";
        const path = str(d, "path") ?? "text";
        if (appendText.length > 0) {
          const kind = (this.rowKind.get(rowId) ?? "").toLowerCase();
          const isTool = kind === "toolcall" || kind.includes("tool");
          if (isTool) {
            if (path === "output.text" || path.includes("output")) {
              const prev = this.toolOutput.get(rowId) ?? "";
              const accumulated = prev + appendText;
              this.toolOutput.set(rowId, accumulated);
              const toolInfo = this.rowTool.get(rowId);
              if (toolInfo !== undefined) {
                updates.push({
                  sessionUpdate: "tool_call_update",
                  toolCallId: toolInfo.toolCallId,
                  title: toolInfo.title,
                  name: toolInfo.name,
                  kind: toolInfo.kind,
                  status: "in_progress",
                  rawOutput: { text: accumulated },
                  content: [{ type: "content", content: { type: "text", text: accumulated } }],
                });
              }
            }
          } else {
            const prev = this.rowText.get(rowId) ?? "";
            this.rowText.set(rowId, prev + appendText);
            const isThought = kind.includes("reasoning") || kind.includes("thought");
            const isSubagent = kind === "subagent";
            if (!isSubagent) {
              updates.push({
                sessionUpdate: isThought ? "agent_thought_chunk" : "agent_message_chunk",
                content: { type: "text", text: appendText },
              });
            }
          }
        }
        continue;
      }

      if (op !== "row.appended" && op !== "row.upserted" && op !== "row.updated") {
        const key = String(op ?? "unknown");
        this.unknownOps.set(key, (this.unknownOps.get(key) ?? 0) + 1);
        continue;
      }

      const row = readRow(recAt(rec(delta), "row"));
      if (row === undefined) continue;
      const rowId = row.rowId;
      const kind = row.kind;
      this.rowKind.set(rowId, kind);

      if (kind === "turnHeader") {
        const state = (str(row.raw, "state") ?? "").toLowerCase();
        this.turnHeaderState = state;
        if (state.includes("fail") || state.includes("error")) {
          turnComplete = true;
          turnFailed = true;
          this.turnPhase = undefined;
          errorMessage = str(recAt(row.raw, "error"), "message") ?? "Turn execution failed";
        } else if (state.includes("interrupt") || state.includes("cancel")) {
          turnComplete = true;
          turnCancelled = true;
          this.turnPhase = undefined;
        } else if (state.includes("complete") || state.includes("success") || state.includes("done")) {
          turnComplete = true;
          this.turnPhase = undefined;
        } else if (state.includes("running") || state.includes("start")) {
          this.turnHeaderState = "running";
        }
        continue;
      }
      if (kind === "userInput" || kind === "meta") continue;

      if (kind === "usage") {
        const used = num(row.raw, "contextUsed");
        const size = num(row.raw, "contextWindow");
        if (used !== undefined && size !== undefined && size > 0) {
          updates.push({ sessionUpdate: "usage_update", used, size });
        }
        const totalTokens = num(row.raw, "totalTokens");
        const inputTokens = num(row.raw, "inputTokens");
        if (totalTokens !== undefined || inputTokens !== undefined) {
          const inTok = inputTokens ?? 0;
          const outTok = num(row.raw, "outputTokens") ?? 0;
          usage = {
            totalTokens: totalTokens ?? inTok + outTok,
            inputTokens: inTok,
            outputTokens: outTok,
            cachedReadTokens: num(row.raw, "cacheReadTokens") ?? 0,
            cachedWriteTokens: num(row.raw, "cacheWriteTokens") ?? 0,
          };
        }
        continue;
      }

      if (kind.includes("assistant") || kind.includes("reasoning") || kind.includes("thought")) {
        const text = str(row.raw, "text") ?? "";
        const prev = this.rowText.get(rowId) ?? "";
        const isAssistant = kind.includes("assistant");
        if (text.length > prev.length) {
          const suffix = text.slice(prev.length);
          this.rowText.set(rowId, text);
          updates.push({
            sessionUpdate: isAssistant ? "agent_message_chunk" : "agent_thought_chunk",
            content: { type: "text", text: suffix },
          });
        }
        const state = (str(row.raw, "state") ?? "").toLowerCase();
        if (state.includes("fail") || state.includes("error")) {
          turnComplete = true;
          turnFailed = true;
          errorMessage = str(recAt(row.raw, "error"), "message") ?? "Assistant generation failed";
        } else if (state.includes("complete") && isAssistant) {
          assistantSettled = true;
        }
        continue;
      }

      if (kind.toLowerCase().includes("error") || kind.toLowerCase().includes("fail")) {
        turnComplete = true;
        turnFailed = true;
        errorMessage =
          str(recAt(row.raw, "error"), "message") ?? str(row.raw, "message") ?? str(row.raw, "text") ?? "Turn error";
        continue;
      }

      if (kind === "subagent") {
        const status = normalizeStatus(str(row.raw, "status"));
        if (status === "in_progress" || status === "pending") {
          this.activeItemIds.add(rowId);
        } else {
          this.activeItemIds.delete(rowId);
        }

        const existing = this.rowTool.get(rowId);
        const subType = str(row.raw, "subagentType") ?? "general";
        const title = str(row.raw, "title") ?? `Subagent: ${subType}`;
        const summary = str(row.raw, "summaryText")?.trim();
        const content: ToolCallContentItem[] | undefined = summary
          ? [{ type: "content", content: { type: "text", text: summary } }]
          : undefined;
        const workId = str(row.raw, "workId");
        const meta =
          bool(row.raw, "backgrounded") === true
            ? { backgrounded: true, ...(workId !== undefined ? { workId } : {}) }
            : undefined;

        if (existing === undefined) {
          const parentToolCallId = str(row.raw, "parentToolCallId");
          const toolCallId = parentToolCallId ?? (workId !== undefined ? `sub_${workId}` : `sub_${rowId}`);
          this.rowTool.set(rowId, { toolCallId, title, name: "subagent", kind: "other" });
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            name: "subagent",
            kind: "other",
            status,
            ...(content !== undefined ? { content } : {}),
            ...(meta !== undefined ? { _meta: meta } : {}),
          });
        } else {
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: existing.toolCallId,
            title,
            name: "subagent",
            kind: "other",
            status,
            ...(content !== undefined ? { content } : {}),
            ...(meta !== undefined ? { _meta: meta } : {}),
          });
        }
        continue;
      }

      if (kind === "toolCall" || kind.includes("tool") || kind.includes("Tool")) {
        const tool = readToolRow(row);
        const rawStatus = tool.status ?? tool.state;
        const isApproval = rawStatus === "pendingApproval" || tool.approvalInteractionId !== undefined;
        const status = isApproval ? "pending" : normalizeStatus(rawStatus);
        if (status === "in_progress" || status === "pending") {
          this.activeItemIds.add(rowId);
        } else {
          this.activeItemIds.delete(rowId);
        }
        const kindCls = classifyToolKind(tool.toolName);

        let rawInput: unknown = tool.input;
        if (rawInput === undefined && typeof tool.inputText === "string" && tool.inputText.trim() !== "") {
          try {
            rawInput = JSON.parse(tool.inputText);
          } catch {
            if (kindCls === "execute") {
              rawInput = { command: tool.inputText };
            }
          }
        }

        if (tool.approvalInteractionId !== undefined) {
          const toolNameStr = tool.toolName ?? tool.name ?? "";
          const isAskUserQuestion = toolNameStr === "AskUserQuestion" || toolNameStr === "ExitPlanMode";
          const inputRecord = rec(rawInput);
          const questionsFromInput = arr(inputRecord, "questions") as PendingInteractionQuestion[] | undefined;

          const interactionItem: PendingInteraction = {
            interactionId: tool.approvalInteractionId,
            kind: isAskUserQuestion ? "userInput" : "permission",
            anchorRowId: rowId >= 0 ? rowId : null,
            payload: {
              kind: isAskUserQuestion ? "userInput" : "permission",
              toolCallId: tool.toolCallId ?? (rowId >= 0 ? `tool_${rowId}` : undefined),
              toolName: toolNameStr,
              summary: tool.title,
              input: rawInput,
              ...(questionsFromInput !== undefined ? { questions: questionsFromInput } : {}),
            },
          };
          const existingIdx = pendingInteractions.findIndex((p) => p.interactionId === tool.approvalInteractionId);
          const existingInteraction = existingIdx >= 0 ? pendingInteractions[existingIdx] : undefined;
          if (existingInteraction !== undefined) {
            pendingInteractions[existingIdx] = {
              ...interactionItem,
              ...existingInteraction,
              payload: {
                ...interactionItem.payload,
                ...existingInteraction.payload,
                ...(questionsFromInput !== undefined && existingInteraction.payload?.questions === undefined
                  ? { questions: questionsFromInput }
                  : {}),
              },
            };
          } else {
            pendingInteractions.push(interactionItem);
          }
          this.pendingInteractionsCount = Math.max(this.pendingInteractionsCount, pendingInteractions.length);
        }

        const inputRecord = rec(rawInput);
        const commandVal =
          typeof inputRecord?.["command"] === "string"
            ? (inputRecord["command"] as string)
            : typeof inputRecord?.["cmd"] === "string"
              ? (inputRecord["cmd"] as string)
              : undefined;

        const pathVal =
          typeof inputRecord?.["path"] === "string"
            ? (inputRecord["path"] as string)
            : typeof inputRecord?.["filePath"] === "string"
              ? (inputRecord["filePath"] as string)
              : typeof inputRecord?.["file"] === "string"
                ? (inputRecord["file"] as string)
                : undefined;

        let title: string;
        if (commandVal !== undefined) {
          title = tool.backgrounded === true ? `[Background] ${commandVal}` : commandVal;
        } else if (pathVal !== undefined) {
          title = `${tool.toolName ?? "File"}: ${pathVal}`;
        } else if (typeof tool.title === "string" && tool.title.trim() !== "") {
          title = tool.title;
        } else if (typeof inputRecord?.["description"] === "string") {
          title = inputRecord["description"] as string;
        } else {
          title = tool.toolName ?? tool.name ?? kind;
        }

        const name = tool.toolName ?? tool.name ?? (kindCls === "execute" ? "bash" : undefined);
        const streamedOutput = this.toolOutput.get(rowId);
        const rawOutput =
          tool.output ??
          (streamedOutput !== undefined ? { text: streamedOutput } : undefined) ??
          tool.outputPreview ??
          (tool.error !== undefined ? { error: tool.error } : undefined);
        const outputText =
          tool.output?.["text"] ??
          streamedOutput ??
          str(tool.outputPreview, "fullText") ??
          str(tool.outputPreview, "text") ??
          tool.progressPreviewLine ??
          tool.error?.["message"];
        const content: ToolCallContentItem[] | undefined =
          typeof outputText === "string" && outputText.length > 0
            ? [{ type: "content", content: { type: "text", text: outputText } }]
            : undefined;
        const locations = pathVal !== undefined ? [{ path: pathVal }] : undefined;
        const meta =
          tool.backgrounded === true
            ? { backgrounded: true, ...(tool.workId !== undefined ? { workId: tool.workId } : {}) }
            : undefined;

        let toolInfo = this.rowTool.get(rowId);
        if (toolInfo === undefined) {
          const toolCallId =
            tool.toolCallId ?? (rowId >= 0 ? `tool_${rowId}` : `tool_${crypto.randomUUID().slice(0, 8)}`);
          toolInfo = { toolCallId, title, name, kind: kindCls };
          this.rowTool.set(rowId, toolInfo);
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            ...(name !== undefined ? { name } : {}),
            kind: kindCls,
            status,
            ...(rawInput !== undefined ? { rawInput } : {}),
            ...(rawOutput !== undefined ? { rawOutput } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(locations !== undefined ? { locations } : {}),
            ...(meta !== undefined ? { _meta: meta } : {}),
          });
        } else {
          if (title) toolInfo.title = title;
          if (name) toolInfo.name = name;
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: toolInfo.toolCallId,
            title,
            ...(name !== undefined ? { name } : {}),
            kind: kindCls,
            status,
            ...(rawInput !== undefined ? { rawInput } : {}),
            ...(rawOutput !== undefined ? { rawOutput } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(locations !== undefined ? { locations } : {}),
            ...(meta !== undefined ? { _meta: meta } : {}),
          });
        }
        continue;
      }

      const key = kind;
      this.unknownKinds.set(key, (this.unknownKinds.get(key) ?? 0) + 1);
      if (DEBUG) {
        this.log(`[translate] unknown row kind=${key} op=${op}:`, JSON.stringify(row.raw).slice(0, 300));
      }
    }

    return this.result(updates, {
      turnComplete,
      assistantSettled,
      turnFailed,
      turnCancelled,
      errorMessage,
      usage,
      pendingInteractions,
    });
  }

  private result(
    updates: AcpUpdate[],
    parts: {
      turnComplete: boolean;
      assistantSettled: boolean;
      turnFailed: boolean;
      turnCancelled: boolean;
      errorMessage?: string;
      usage?: TurnUsage;
      pendingInteractions: PendingInteraction[];
    },
  ): FoldResult {
    return {
      updates,
      turnComplete: parts.turnComplete,
      assistantSettled: parts.assistantSettled,
      hasActiveWork: this.hasActiveWork(),
      turnFailed: parts.turnFailed,
      turnCancelled: parts.turnCancelled,
      ...(parts.errorMessage !== undefined ? { errorMessage: parts.errorMessage } : {}),
      ...(parts.usage !== undefined ? { usage: parts.usage } : {}),
      ...(parts.pendingInteractions.length > 0 ? { pendingInteractions: parts.pendingInteractions } : {}),
    };
  }
}

const readPendingInteraction = (value: unknown): PendingInteraction | undefined => {
  const r = rec(value);
  if (str(r, "interactionId") === undefined) return undefined;
  // Raw passthrough (parity): snapshot interactions flow through verbatim —
  // downstream consumers re-read optional fields off the original payload.
  return value as PendingInteraction;
};

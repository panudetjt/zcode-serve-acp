/**
 * Daemon conversation frames → ACP `session/update` notifications.
 *
 * Frame shape (ground-truthed 18 พ.ย. 2026, wireVersion 3):
 *   payload: { kind: "deltas", deltas: [
 *     { op: "state.updated", patch: {...} },
 *     { op: "row.appended" | "row.upserted" | "row.updated",
 *       row: { rowId, kind: "turnHeader"|"userInput"|"reasoning"|"assistant"|
 *              "toolCall"…, text, state: "streaming"|"running"|"complete"|…,
 *              title?, name? } },
 *     … ] }
 *
 * `assistant`/`reasoning` rows carry the ACCUMULATED text on every upsert —
 * the translator diffs per rowId so ACP receives only the new suffix.
 */
import { randomUUID } from "node:crypto";

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

const DEBUG = process.env.ZCODE_SERVE_ACP_DEBUG === "1";

interface Row {
  rowId?: number;
  kind?: string;
  text?: string;
  state?: string;
  status?: string;
  title?: string;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  inputText?: string;
  input?: unknown;
  output?: { text?: string };
  outputPreview?: { text?: string; fullText?: string; totalLines?: number; totalBytes?: number };
  error?: { code?: string; message?: string };
  backgrounded?: boolean;
  workId?: string;
  parentToolCallId?: string;
  subagentType?: string;
  summaryText?: string;
}

export function classifyToolKind(toolName?: string): string {
  const t = (toolName ?? "").toLowerCase();
  if (
    t === "bash" ||
    t === "shell" ||
    t === "terminal" ||
    t === "exec" ||
    t === "execute" ||
    t === "execute_command" ||
    t === "run_command" ||
    t === "command"
  ) {
    return "execute";
  }
  if (t === "readfile" || t === "read_file" || t === "view_file" || t === "cat" || t === "read") {
    return "read";
  }
  if (
    t === "editfile" ||
    t === "write_file" ||
    t === "edit_file" ||
    t === "patch" ||
    t === "write" ||
    t === "replace_file_content" ||
    t === "append_file"
  ) {
    return "edit";
  }
  if (t === "grep" || t === "find" || t === "glob" || t === "search" || t === "search_web" || t === "rg") {
    return "search";
  }
  return "other";
}

function normalizeStatus(state: string | undefined): string {
  const s = (state ?? "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "done" || s === "success") return "completed";
  if (s === "failed" || s === "error" || s.includes("fail") || s.includes("cancel") || s.includes("interrupt")) return "failed";
  if (s === "pending" || s.includes("wait") || s === "inputstreaming" || s === "pendingapproval") return "pending";
  return "in_progress";
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

export class FrameTranslator {
  private rowText = new Map<number, string>();
  private rowKind = new Map<number, string>();
  private rowTool = new Map<number, { toolCallId: string; title: string; name?: string; kind?: string }>();
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

  /** True when a delta marks the turn as finished or failed. */
  fold(payload: unknown): FoldResult {
    let turnComplete = false;
    let assistantSettled = false;
    let turnFailed = false;
    let turnCancelled = false;
    let errorMessage: string | undefined;
    let usage: TurnUsage | undefined;
    const updates: AcpUpdate[] = [];
    const pendingInteractions: PendingInteraction[] = [];
    const envelope = payload as {
      frame?: { payload?: { kind?: string; deltas?: unknown[]; snapshot?: { pendingInteractions?: unknown[] }; error?: unknown; failure?: unknown } };
      payload?: { kind?: string; deltas?: unknown[]; snapshot?: { pendingInteractions?: unknown[] }; error?: unknown; failure?: unknown };
      deltas?: unknown[];
      snapshot?: { pendingInteractions?: unknown[] };
      error?: unknown;
      failure?: unknown;
    };
    const rawError =
      envelope.frame?.payload?.error ??
      envelope.frame?.payload?.failure ??
      envelope.payload?.error ??
      envelope.payload?.failure ??
      envelope.error ??
      envelope.failure;
    if (rawError !== undefined && rawError !== null) {
      turnComplete = true;
      turnFailed = true;
      errorMessage =
        typeof rawError === "string"
          ? rawError
          : ((rawError as { message?: string })?.message ?? JSON.stringify(rawError));
    }

    const inner =
      envelope.frame?.payload ??
      envelope.payload ??
      (envelope.deltas !== undefined ? { kind: "deltas", deltas: envelope.deltas } : undefined);

    const snapshot =
      (inner as { snapshot?: { pendingInteractions?: unknown[] } })?.snapshot ??
      envelope.snapshot ??
      envelope.frame?.payload?.snapshot ??
      envelope.payload?.snapshot;
    if (snapshot?.pendingInteractions !== undefined && Array.isArray(snapshot.pendingInteractions)) {
      this.pendingInteractionsCount = snapshot.pendingInteractions.length;
      for (const item of snapshot.pendingInteractions as PendingInteraction[]) {
        if (item && item.interactionId) {
          pendingInteractions.push(item);
        }
      }
    }

    const deltas = inner?.kind === "deltas" ? (inner.deltas ?? []) : [];
    if (!Array.isArray(deltas) || deltas.length === 0) {
      return {
        updates,
        turnComplete,
        assistantSettled,
        hasActiveWork: this.hasActiveWork(),
        turnFailed,
        turnCancelled,
        errorMessage,
        usage,
        ...(pendingInteractions.length > 0 ? { pendingInteractions } : {}),
      };
    }
    // Pre-register row kinds from all deltas in this batch
    for (const delta of deltas) {
      const d = delta as { row?: Row };
      if (d.row && typeof d.row.rowId === "number" && typeof d.row.kind === "string") {
        this.rowKind.set(d.row.rowId, d.row.kind);
      }
    }

    for (const delta of deltas) {
      const op = (delta as { op?: string })?.op;

      if (op === "state.updated") {
        const patch = (delta as {
          patch?: {
            control?: {
              lastError?: { message?: string; code?: string } | null;
              phase?: string;
              sessionEnded?: boolean;
              stopState?: string;
              activeWorks?: unknown[];
            };
            pendingInteractions?: unknown[];
            usage?: {
              contextWindow?: { usedTokens?: number; maxTokens?: number };
              cumulative?: {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadTokens?: number;
                cacheWriteTokens?: number;
              };
            };
          };
        })?.patch;
        if (patch?.control?.lastError) {
          turnComplete = true;
          turnFailed = true;
          this.turnPhase = undefined;
          this.activeWorksCount = 0;
          this.pendingInteractionsCount = 0;
          errorMessage = patch.control.lastError.message ?? `Daemon error: ${patch.control.lastError.code}`;
        }
        if (patch?.control?.activeWorks !== undefined) {
          this.activeWorksCount = Array.isArray(patch.control.activeWorks) ? patch.control.activeWorks.length : 0;
        }
        if (patch?.pendingInteractions !== undefined && Array.isArray(patch.pendingInteractions)) {
          this.pendingInteractionsCount = patch.pendingInteractions.length;
          for (const item of patch.pendingInteractions as PendingInteraction[]) {
            if (item && item.interactionId) {
              pendingInteractions.push(item);
            }
          }
        }
        const phase = patch?.control?.phase;
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
            errorMessage = patch?.control?.lastError?.message ?? "Turn execution failed in daemon";
          } else if (phase === "running" || phase === "prewarming") {
            this.turnPhase = "running";
          }
        }
        if (
          patch?.control?.stopState === "stopping" ||
          (patch?.control?.sessionEnded === true && this.activeWorksCount === 0)
        ) {
          turnComplete = true;
          this.turnPhase = undefined;
          this.turnHeaderState = undefined;
          this.activeWorksCount = 0;
        }
        if (patch?.usage) {
          const used = patch.usage.contextWindow?.usedTokens;
          const size = patch.usage.contextWindow?.maxTokens;
          if (typeof used === "number" && typeof size === "number" && size > 0) {
            updates.push({
              sessionUpdate: "usage_update",
              used,
              size,
            });
          }
          const cum = patch.usage.cumulative;
          if (cum) {
            const inTok = cum.inputTokens ?? 0;
            const outTok = cum.outputTokens ?? 0;
            usage = {
              totalTokens: inTok + outTok,
              inputTokens: inTok,
              outputTokens: outTok,
              cachedReadTokens: cum.cacheReadTokens ?? 0,
              cachedWriteTokens: cum.cacheWriteTokens ?? 0,
            };
          }
        }
        continue;
      }

      if (op === "row.delta") {
        const deltaObj = delta as { rowId?: number; append?: string; path?: string };
        const rowId = typeof deltaObj.rowId === "number" ? deltaObj.rowId : -1;
        const appendText = typeof deltaObj.append === "string" ? deltaObj.append : "";
        const path = typeof deltaObj.path === "string" ? deltaObj.path : "text";
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
      const row = (delta as { row?: Row }).row;
      if (row === undefined) continue;
      const rowId = typeof row.rowId === "number" ? row.rowId : -1;
      const kind = row.kind ?? "?";
      this.rowKind.set(rowId, kind);

      if (kind === "turnHeader") {
        const state = (row.state ?? "").toLowerCase();
        this.turnHeaderState = state;
        if (state.includes("fail") || state.includes("error")) {
          turnComplete = true;
          turnFailed = true;
          this.turnPhase = undefined;
          errorMessage = (row as { error?: { message?: string } }).error?.message ?? "Turn execution failed";
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
        const rawRow = row as {
          contextUsed?: number;
          contextWindow?: number;
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
        if (typeof rawRow.contextUsed === "number" && typeof rawRow.contextWindow === "number" && rawRow.contextWindow > 0) {
          updates.push({
            sessionUpdate: "usage_update",
            used: rawRow.contextUsed,
            size: rawRow.contextWindow,
          });
        }
        if (typeof rawRow.totalTokens === "number" || typeof rawRow.inputTokens === "number") {
          const inTok = rawRow.inputTokens ?? 0;
          const outTok = rawRow.outputTokens ?? 0;
          usage = {
            totalTokens: rawRow.totalTokens ?? (inTok + outTok),
            inputTokens: inTok,
            outputTokens: outTok,
            cachedReadTokens: rawRow.cacheReadTokens ?? 0,
            cachedWriteTokens: rawRow.cacheWriteTokens ?? 0,
          };
        }
        continue;
      }

      if (kind.includes("assistant") || kind.includes("reasoning") || kind.includes("thought")) {
        const text = row.text ?? "";
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
        const state = (row.state ?? "").toLowerCase();
        if (state.includes("fail") || state.includes("error")) {
          turnComplete = true;
          turnFailed = true;
          errorMessage = (row as { error?: { message?: string } }).error?.message ?? "Assistant generation failed";
        } else if (state.includes("complete") && isAssistant) {
          assistantSettled = true;
        }
        continue;
      }

      if (kind.toLowerCase().includes("error") || kind.toLowerCase().includes("fail")) {
        turnComplete = true;
        turnFailed = true;
        errorMessage =
          (row as { error?: { message?: string }; text?: string; message?: string }).error?.message ??
          (row as { text?: string; message?: string }).message ??
          (row as { text?: string; message?: string }).text ??
          "Turn error";
        continue;
      }

      if (kind === "subagent") {
        const rawSub = row as {
          subagentType?: string;
          status?: string;
          summaryText?: string;
          childSessionId?: string;
          parentToolCallId?: string;
          workId?: string;
          backgrounded?: boolean;
          title?: string;
        };
        const status = normalizeStatus(rawSub.status);
        if (status === "in_progress" || status === "pending") {
          this.activeItemIds.add(rowId);
        } else {
          this.activeItemIds.delete(rowId);
        }

        let existing = this.rowTool.get(rowId);
        const subType = rawSub.subagentType || "general";
        const title = rawSub.title ?? `Subagent: ${subType}`;
        const summary = rawSub.summaryText?.trim();
        const content: ToolCallContentItem[] | undefined = summary
          ? [{ type: "content", content: { type: "text", text: summary } }]
          : undefined;
        const meta = rawSub.backgrounded
          ? { backgrounded: true, ...(rawSub.workId ? { workId: rawSub.workId } : {}) }
          : undefined;

        if (existing === undefined) {
          const toolCallId = rawSub.parentToolCallId ?? (rawSub.workId ? `sub_${rawSub.workId}` : `sub_${rowId}`);
          this.rowTool.set(rowId, { toolCallId, title, name: "subagent", kind: "other" });
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            name: "subagent",
            kind: "other",
            status,
            ...(content ? { content } : {}),
            ...(meta ? { _meta: meta } : {}),
          });
        } else {
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: existing.toolCallId,
            title,
            name: "subagent",
            kind: "other",
            status,
            ...(content ? { content } : {}),
            ...(meta ? { _meta: meta } : {}),
          });
        }
        continue;
      }

      if (kind === "toolCall" || kind.includes("tool") || kind.includes("Tool")) {
        const rawTool = row as {
          status?: string;
          state?: string;
          title?: string;
          toolName?: string;
          name?: string;
          toolCallId?: string;
          inputText?: string;
          input?: unknown;
          output?: { text?: string };
          outputPreview?: { text?: string; fullText?: string; totalLines?: number; totalBytes?: number };
          error?: { code?: string; message?: string };
          backgrounded?: boolean;
          workId?: string;
        };
        const rawStatus = rawTool.status ?? rawTool.state;
        const approvalInteractionId = (rawTool as { approvalInteractionId?: string }).approvalInteractionId;
        const isApproval = rawStatus === "pendingApproval" || Boolean(approvalInteractionId);
        const status = isApproval ? "pending" : normalizeStatus(rawStatus);
        if (status === "in_progress" || status === "pending") {
          this.activeItemIds.add(rowId);
        } else {
          this.activeItemIds.delete(rowId);
        }
        const kindCls = classifyToolKind(rawTool.toolName);
        let rawInput: unknown = rawTool.input;
        if (rawInput === undefined && typeof rawTool.inputText === "string" && rawTool.inputText.trim() !== "") {
          try {
            rawInput = JSON.parse(rawTool.inputText);
          } catch {
            if (kindCls === "execute") {
              rawInput = { command: rawTool.inputText };
            }
          }
        }

        if (approvalInteractionId) {
          const toolNameStr = rawTool.toolName ?? rawTool.name ?? "";
          const isAskUserQuestion =
            toolNameStr === "AskUserQuestion" ||
            toolNameStr === "ExitPlanMode";
          const inputRecord = rawInput as Record<string, unknown> | undefined;
          const questionsFromInput = Array.isArray(inputRecord?.questions)
            ? (inputRecord.questions as PendingInteractionQuestion[])
            : undefined;

          const interactionItem: PendingInteraction = {
            interactionId: approvalInteractionId,
            kind: isAskUserQuestion ? "userInput" : "permission",
            anchorRowId: rowId >= 0 ? rowId : null,
            payload: {
              kind: isAskUserQuestion ? "userInput" : "permission",
              toolCallId: rawTool.toolCallId ?? (rowId >= 0 ? `tool_${rowId}` : undefined),
              toolName: toolNameStr,
              summary: rawTool.title,
              input: rawInput,
              ...(questionsFromInput ? { questions: questionsFromInput } : {}),
            },
          };
          const existingIdx = pendingInteractions.findIndex((p) => p.interactionId === approvalInteractionId);
          if (existingIdx >= 0) {
            pendingInteractions[existingIdx] = {
              ...interactionItem,
              ...pendingInteractions[existingIdx],
              payload: {
                ...interactionItem.payload,
                ...pendingInteractions[existingIdx].payload,
                ...(questionsFromInput && !pendingInteractions[existingIdx].payload?.questions
                  ? { questions: questionsFromInput }
                  : {}),
              },
            };
          } else {
            pendingInteractions.push(interactionItem);
          }
          this.pendingInteractionsCount = Math.max(this.pendingInteractionsCount, pendingInteractions.length);
        }

        const commandVal =
          typeof (rawInput as { command?: unknown })?.command === "string"
            ? (rawInput as { command: string }).command
            : typeof (rawInput as { cmd?: unknown })?.cmd === "string"
            ? (rawInput as { cmd: string }).cmd
            : undefined;

        const pathVal =
          typeof (rawInput as { path?: unknown })?.path === "string"
            ? (rawInput as { path: string }).path
            : typeof (rawInput as { filePath?: unknown })?.filePath === "string"
            ? (rawInput as { filePath: string }).filePath
            : typeof (rawInput as { file?: unknown })?.file === "string"
            ? (rawInput as { file: string }).file
            : undefined;

        let title: string;
        if (commandVal) {
          title = rawTool.backgrounded ? `[Background] ${commandVal}` : commandVal;
        } else if (pathVal) {
          title = `${rawTool.toolName || "File"}: ${pathVal}`;
        } else if (typeof rawTool.title === "string" && rawTool.title.trim() !== "") {
          title = rawTool.title;
        } else if (typeof (rawInput as { description?: unknown })?.description === "string") {
          title = (rawInput as { description: string }).description;
        } else {
          title = rawTool.toolName ?? rawTool.name ?? kind;
        }

        const name = rawTool.toolName ?? rawTool.name ?? (kindCls === "execute" ? "bash" : undefined);
        const streamedOutput = this.toolOutput.get(rowId);
        const rawOutput =
          rawTool.output ??
          (streamedOutput !== undefined ? { text: streamedOutput } : undefined) ??
          rawTool.outputPreview ??
          (rawTool.error ? { error: rawTool.error } : undefined);
        const outputText =
          rawTool.output?.text ??
          streamedOutput ??
          rawTool.outputPreview?.fullText ??
          rawTool.outputPreview?.text ??
          (rawTool as { progress?: { previewLine?: string } }).progress?.previewLine ??
          rawTool.error?.message;
        const content: ToolCallContentItem[] | undefined =
          typeof outputText === "string" && outputText.length > 0
            ? [{ type: "content", content: { type: "text", text: outputText } }]
            : undefined;
        const locations = pathVal ? [{ path: pathVal }] : undefined;
        const meta = rawTool.backgrounded
          ? { backgrounded: true, ...(rawTool.workId ? { workId: rawTool.workId } : {}) }
          : undefined;

        let toolInfo = this.rowTool.get(rowId);
        if (toolInfo === undefined) {
          const toolCallId =
            rawTool.toolCallId ?? (rowId >= 0 ? `tool_${rowId}` : `tool_${randomUUID().slice(0, 8)}`);
          toolInfo = { toolCallId, title, name, kind: kindCls };
          this.rowTool.set(rowId, toolInfo);
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            ...(name ? { name } : {}),
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
            ...(name ? { name } : {}),
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
        this.log(`[translate] unknown row kind=${key} op=${op}:`, JSON.stringify(row).slice(0, 300));
      }
    }
    return {
      updates,
      turnComplete,
      assistantSettled,
      hasActiveWork: this.hasActiveWork(),
      turnFailed,
      turnCancelled,
      errorMessage,
      usage,
      ...(pendingInteractions.length > 0 ? { pendingInteractions } : {}),
    };
  }

  debugSummary(): string {
    return `ops=${[...this.unknownOps.entries()].map(([k, v]) => `${k}×${v}`).join(",") || "-"} kinds=${
      [...this.unknownKinds.entries()].map(([k, v]) => `${k}×${v}`).join(",") || "-"
    }`;
  }
}

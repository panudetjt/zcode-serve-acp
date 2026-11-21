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
import { envDebug } from "../config.ts";
import type { SubagentsSnapshot } from "../serve/session.ts";

/** Cap for the per-child activity text folded into a subagent card — a live tail, not an archive. */
const CHILD_OUTPUT_CAP = 16_000;

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
  /** Child session ids newly seen on subagent rows — the caller subscribes `conversation/<id>`. */
  newChildren?: string[];
  /** Child session ids whose subagent row reached a terminal status — the caller unsubscribes. */
  settledChildren?: string[];
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
  rawOutput: unknown;
  output: Rec | undefined;
  outputPreview: Rec | undefined;
  error: Rec | undefined;
  backgrounded: boolean | undefined;
  workId: string | undefined;
  approvalInteractionId: string | undefined;
  progressPreviewLine: string | undefined;
}

const extractFallbackOutputText = (output: Rec | undefined): string | undefined => {
  if (output === undefined || output["text"] !== undefined) return undefined;
  if (typeof output["result"] === "string") return output["result"];
  if (typeof output["value"] === "string") return output["value"];
  return JSON.stringify(output);
};

const readToolRow = (row: Row): ToolRow => ({
  status: str(row.raw, "status"),
  state: str(row.raw, "state"),
  title: str(row.raw, "title"),
  toolName: str(row.raw, "toolName") ?? str(row.raw, "name"),
  name: str(row.raw, "name"),
  toolCallId: str(row.raw, "toolCallId"),
  inputText: str(row.raw, "inputText"),
  input: row.raw["input"],
  rawOutput: row.raw["output"],
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

// DEBUG is read per instance (below), not at module load, so tests can flip
// ZCODE_SERVE_ACP_DEBUG between translator constructions.

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
  private readonly debug = envDebug();
  private activeWorksCount = 0;
  private pendingInteractionsCount = 0;

  // Child-session drill-down (feature: live subagent cards). The daemon does
  // NOT inline child rows — subagentRowSchema.childSessionId documents the
  // contract: "存在 → UI 可下钻订阅 conversation/<childSessionId>（不内嵌
  // child rows）" (server-core.js 3.19.0). This bridge subscribes the child
  // topic itself and folds child frames via foldChild into the parent card.
  private childTool = new Map<string, string>(); // childSessionId → parent card toolCallId
  private toolChild = new Map<string, string>(); // parent card toolCallId → childSessionId
  private childTitle = new Map<string, string>(); // childSessionId → parent card title
  private childSettled = new Set<string>();
  private childOutput = new Map<string, string>(); // childSessionId → accumulated activity text
  private childRowKind = new Map<string, string>(); // `${childId}#${rowId}` → kind
  private childRowText = new Map<string, string>(); // `${childId}#${rowId}` → accumulated text
  private childToolLineDrawn = new Set<string>(); // `${childId}#${rowId}` tool rows already rendered
  private childFailLineDrawn = new Set<string>(); // `${childId}#${rowId}` tool rows whose failure line was rendered

  constructor(private readonly log: (...parts: unknown[]) => void) {}

  startTurn(): void {
    this.turnPhase = "running";
    this.turnHeaderState = "running";
    this.activeWorksCount = 1;
    this.pendingInteractionsCount = 0;
    this.activeItemIds.clear();
    this.toolOutput.clear();
    this.childRowKind.clear();
    this.childRowText.clear();
    this.childToolLineDrawn.clear();
    this.childFailLineDrawn.clear();
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

  /**
   * Fold one CHILD conversation frame (topic `conversation/<childSessionId>`)
   * into the parent's subagent card. The daemon does not inline child rows —
   * subagentRowSchema.childSessionId documents the drill-down contract ("UI
   * 可下钻订阅 conversation/<childSessionId>", server-core.js 3.19.0) — so the
   * bridge subscribes the child topic itself and streams the child's activity
   * into the card's rawOutput/content, the same way parent tool rows stream
   * `output.text` deltas.
   *
   * Child rows live in the child conversation's own rowId space; all state is
   * keyed `${childSessionId}#${rowId}` so it can never collide with parent
   * rows. Frames for unbound (never seen on a subagent row / RPC) or settled
   * children are ignored, and this method never touches turn lifecycle state —
   * the parent conversation owns the turn.
   */
  foldChild(childSessionId: string, payload: unknown): { updates: AcpUpdate[] } {
    const updates: AcpUpdate[] = [];
    const toolCallId = this.childTool.get(childSessionId);
    if (toolCallId === undefined || this.childSettled.has(childSessionId)) return { updates };

    const envelope = unwrapEnvelope(payload);
    const deltas = envelope?.deltas ?? [];
    if (deltas.length === 0) return { updates };

    let appended = false;
    for (const delta of deltas) {
      const op = str(rec(delta), "op");

      if (op === "row.delta") {
        const d = rec(delta);
        const rowId = num(d, "rowId") ?? -1;
        const appendText = str(d, "append") ?? "";
        const path = str(d, "path") ?? "text";
        const key = `${childSessionId}#${rowId}`;
        const rowKind = this.childRowKind.get(key) ?? "";
        const isTool = rowKind === "toolCall" || rowKind.includes("tool");
        if (appendText.length === 0 || isTool || path.includes("output")) continue;
        const prev = this.childRowText.get(key) ?? "";
        this.childRowText.set(key, prev + appendText);
        this.appendChildText(childSessionId, appendText);
        appended = true;
        continue;
      }

      if (op !== "row.appended" && op !== "row.upserted" && op !== "row.updated") continue;
      const row = readRow(recAt(rec(delta), "row"));
      if (row === undefined) continue;
      const key = `${childSessionId}#${row.rowId}`;
      this.childRowKind.set(key, row.kind);
      const lower = row.kind.toLowerCase();

      if (lower.includes("assistant") || lower.includes("reasoning") || lower.includes("thought")) {
        const text = str(row.raw, "text") ?? "";
        const prev = this.childRowText.get(key) ?? "";
        if (text.length > prev.length) {
          this.childRowText.set(key, text);
          this.appendChildText(childSessionId, text.slice(prev.length));
          appended = true;
        }
        continue;
      }

      if (lower.includes("tool")) {
        if (!this.childToolLineDrawn.has(key)) {
          this.childToolLineDrawn.add(key);
          const toolName = str(row.raw, "toolName") ?? str(row.raw, "name");
          const rowTitle = str(row.raw, "title");
          const label =
            toolName !== undefined
              ? `${toolName}${rowTitle !== undefined ? `: ${rowTitle}` : ""}`
              : (rowTitle ?? row.kind);
          this.appendChildText(childSessionId, `⏺ ${label}`, { asLine: true });
          appended = true;
        }
        const status = normalizeStatus(str(row.raw, "status") ?? str(row.raw, "state"));
        if (status === "failed" && !this.childFailLineDrawn.has(key)) {
          this.childFailLineDrawn.add(key);
          const message = str(recAt(row.raw, "error"), "message") ?? "failed";
          this.appendChildText(childSessionId, `  ⎿ ${message}`, { asLine: true });
          appended = true;
        }
        continue;
      }
      // turnHeader / userInput / meta / usage / error rows — not card activity.
    }

    if (appended) {
      const text = this.childOutput.get(childSessionId);
      const title = this.childTitle.get(childSessionId);
      if (text !== undefined && text.length > 0) {
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId,
          ...(title !== undefined ? { title } : {}),
          name: "subagent",
          kind: "other",
          status: "in_progress",
          rawOutput: { text },
          content: [{ type: "content", content: { type: "text", text } }],
        });
      }
    }
    return { updates };
  }

  private appendChildText(childSessionId: string, text: string, opts?: { asLine?: boolean }): void {
    const prev = this.childOutput.get(childSessionId) ?? "";
    const boundary = opts?.asLine === true && prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
    let next = prev + boundary + text;
    if (next.length > CHILD_OUTPUT_CAP) {
      next = `…[truncated]\n${next.slice(next.length - CHILD_OUTPUT_CAP)}`;
    }
    this.childOutput.set(childSessionId, next);
  }

  /**
   * Bind a child session id onto an existing card from the `session/subagents`
   * result (sessionSubagents, server-core.js 3.19.0:64180, whose entries carry
   * childSessionId + the parent toolCallId) — used when subagent rows arrived
   * without childSessionId. Returns true only when a NEW bindable mapping was
   * made (the caller then subscribes `conversation/<childSessionId>`).
   */
  bindChildSession(childSessionId: string, toolCallId: string | undefined): boolean {
    if (childSessionId === "" || toolCallId === undefined || toolCallId === "") return false;
    if (this.childTool.has(childSessionId) || this.childSettled.has(childSessionId)) return false;
    for (const info of this.rowTool.values()) {
      if (info.toolCallId === toolCallId) {
        this.childTool.set(childSessionId, toolCallId);
        this.toolChild.set(toolCallId, childSessionId);
        this.childTitle.set(childSessionId, info.title);
        return true;
      }
    }
    return false;
  }

  /**
   * Mark a child session settled (e.g. from session/subagents ended list) and
   * clean up its output buffer. Returns true if the child was known and not
   * previously settled.
   */
  settleChild(childSessionId: string): boolean {
    if (childSessionId === "" || this.childSettled.has(childSessionId)) return false;
    if (!this.childTool.has(childSessionId)) return false;
    this.childSettled.add(childSessionId);
    this.childOutput.delete(childSessionId);
    return true;
  }

  /**
   * Render a `session/subagents` snapshot as a compact batch overview, emitted
   * as agent text while the turn runs so the client sees the whole batch even
   * before any card goes live. Returns undefined when the session has no
   * subagents at all (nothing worth a content line).
   */
  formatSubagentsSummary(snapshot: SubagentsSnapshot): string | undefined {
    if (snapshot.running.length === 0 && snapshot.ended.total === 0) return undefined;
    const line = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 120);
    const rows: string[] = [];
    for (const entry of snapshot.running) {
      const title = line(entry.title !== undefined && entry.title !== "" ? entry.title : entry.subagentType);
      rows.push(`▸ ${entry.subagentType}: ${title}${entry.status === "running" ? "" : ` (${entry.status})`}`);
    }
    for (const entry of snapshot.ended.items) {
      const mark = entry.status === "success" ? "✓" : "✗";
      rows.push(
        `${mark} ${entry.subagentType}: ${line(entry.title !== undefined && entry.title !== "" ? entry.title : entry.subagentType)}`,
      );
    }
    const shown = rows.slice(0, 12);
    const overflow = rows.length - shown.length;
    const header = `Subagents — ${snapshot.running.length} running, ${snapshot.ended.total} done`;
    return [header, ...shown, ...(overflow > 0 ? [`… and ${overflow} more`] : [])].join("\n");
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
    const newChildren: string[] = [];
    const settledChildren: string[] = [];

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
        newChildren,
        settledChildren,
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
            } else if (path === "summaryText") {
              // summaryText streams as a row path (streamablePathSchema,
              // server-core.js 3.19.0:4377) — surface it on the card as it
              // arrives instead of waiting for the next full row upsert.
              const toolInfo = this.rowTool.get(rowId);
              if (toolInfo !== undefined) {
                updates.push({
                  sessionUpdate: "tool_call_update",
                  toolCallId: toolInfo.toolCallId,
                  title: toolInfo.title,
                  name: "subagent",
                  kind: "other",
                  status: "in_progress",
                  content: [{ type: "content", content: { type: "text", text: prev + appendText } }],
                });
              }
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
        // Seed the summary buffer so streaming summaryText deltas (see the
        // row.delta handler) append onto the latest known summary instead of
        // starting from an empty string.
        const rawSummary = str(row.raw, "summaryText");
        if (rawSummary !== undefined) this.rowText.set(rowId, rawSummary);
        const content: ToolCallContentItem[] | undefined = summary
          ? [{ type: "content", content: { type: "text", text: summary } }]
          : undefined;
        const workId = str(row.raw, "workId");
        const meta =
          bool(row.raw, "backgrounded") === true
            ? { backgrounded: true, ...(workId !== undefined ? { workId } : {}) }
            : undefined;

        const parentToolCallId = str(row.raw, "parentToolCallId");
        const toolCallId =
          existing?.toolCallId ?? parentToolCallId ?? (workId !== undefined ? `sub_${workId}` : `sub_${rowId}`);

        // Drill-down contract (see child fields above): the row carries the
        // child conversation id once the daemon knows it — surface it so the
        // caller subscribes conversation/<childSessionId> and folds child
        // frames into this card. Fall back to toolChild for cross-filled bindings.
        const rawChildSessionId = str(row.raw, "childSessionId");
        const childSessionId =
          rawChildSessionId !== undefined && rawChildSessionId !== ""
            ? rawChildSessionId
            : this.toolChild.get(toolCallId);
        if (childSessionId !== undefined && childSessionId !== "") {
          if (!this.childTool.has(childSessionId)) {
            this.childTool.set(childSessionId, toolCallId);
            this.toolChild.set(toolCallId, childSessionId);
            this.childTitle.set(childSessionId, title);
            if (!this.childSettled.has(childSessionId)) newChildren.push(childSessionId);
          }
        }
        let settlingChildOutput: string | undefined;
        if (
          (status === "completed" || status === "failed") &&
          childSessionId !== undefined &&
          this.childTool.has(childSessionId) &&
          !this.childSettled.has(childSessionId)
        ) {
          this.childSettled.add(childSessionId);
          // Carry the streamed child activity through the completing update —
          // otherwise the live transcript vanishes from the card on settle and
          // only the summary remains (seen live in probe-subagents.mjs).
          settlingChildOutput = this.childOutput.get(childSessionId);
          this.childOutput.delete(childSessionId);
          settledChildren.push(childSessionId);
        }
        const childRawOutput =
          settlingChildOutput !== undefined && settlingChildOutput.length > 0
            ? { rawOutput: { text: settlingChildOutput } }
            : {};

        if (existing === undefined) {
          this.rowTool.set(rowId, { toolCallId, title, name: "subagent", kind: "other" });
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            name: "subagent",
            kind: "other",
            status,
            ...(content !== undefined ? { content } : {}),
            ...childRawOutput,
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
            ...childRawOutput,
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
          tool.rawOutput ??
          (streamedOutput !== undefined ? { text: streamedOutput } : undefined) ??
          tool.outputPreview ??
          (tool.error !== undefined ? { error: tool.error } : undefined);
        const outputText =
          (typeof tool.rawOutput === "string" ? tool.rawOutput : undefined) ??
          tool.output?.["text"] ??
          streamedOutput ??
          str(tool.outputPreview, "fullText") ??
          str(tool.outputPreview, "text") ??
          tool.progressPreviewLine ??
          tool.error?.["message"] ??
          extractFallbackOutputText(tool.output);
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
      if (this.debug) {
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
      newChildren,
      settledChildren,
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
      newChildren?: string[];
      settledChildren?: string[];
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
      ...((parts.newChildren?.length ?? 0) > 0 ? { newChildren: parts.newChildren } : {}),
      ...((parts.settledChildren?.length ?? 0) > 0 ? { settledChildren: parts.settledChildren } : {}),
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

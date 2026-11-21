/**
 * Permission/elicitation interaction logic — extracted as pure functions from
 * the pre-rewrite AcpServer so tests exercise the real code instead of
 * probing privates with `as unknown as` casts.
 *
 * The daemon signals interactions two ways: as `pendingInteractions` inside
 * conversation frames (handled by handlePendingInteraction here), or as
 * daemon→client server requests on the channel (handled by
 * answerPermissionServerRequest). Both paths shared near-verbatim option
 * classification in the old code — now they share these functions.
 */
import { classifyToolKind } from "../translate/toolKind.ts";
import type {
  PendingInteraction,
  PendingInteractionOption,
  PendingInteractionQuestion,
} from "../translate/translator.ts";

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const STR = (r: Record<string, unknown> | undefined, key: string): string | undefined => str(r?.[key]);

export interface MappedPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** Daemon option kind strings → ACP permission option kinds. */
export function mapPermissionOptions(rawOptions: Array<Record<string, unknown>>): MappedPermissionOption[] {
  return rawOptions.map((o, i) => {
    const kindStr = String(o.kind ?? "").toLowerCase();
    let kind: MappedPermissionOption["kind"] = "allow_once";
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
}

export interface RawPermissionAnswer {
  outcome?: { outcome?: string; optionId?: string };
  optionId?: string;
}

/** Client permission answer → daemon optionId (same fallbacks as pre-rewrite). */
export function extractPermissionOptionId(
  answer: RawPermissionAnswer,
  rawOptions: Array<Record<string, unknown>>,
  mappedOptions: MappedPermissionOption[],
): string | undefined {
  let chosenOptionId: string | undefined;
  const outcomeObj = answer.outcome;
  if (outcomeObj) {
    if (outcomeObj.outcome === "selected") {
      chosenOptionId = outcomeObj.optionId;
    } else if (outcomeObj.outcome === "denied" || outcomeObj.outcome === "cancelled") {
      const denyOpt = rawOptions.find(
        (o) =>
          String(o.kind ?? "")
            .toLowerCase()
            .includes("deny") ||
          String(o.optionId ?? "")
            .toLowerCase()
            .includes("deny"),
      );
      chosenOptionId = (denyOpt?.optionId as string) ?? "deny";
    }
  }
  if (!chosenOptionId) {
    chosenOptionId = answer.optionId;
  }
  if (!chosenOptionId && mappedOptions.length > 0) {
    chosenOptionId = mappedOptions[0]?.optionId;
  }
  if (chosenOptionId === "allow" && !rawOptions.some((o) => o.optionId === "allow")) {
    chosenOptionId = "allow_once";
  }
  return chosenOptionId;
}

/** Frame-driven interactions route to elicitation/create or request_permission. */
export function isElicitation(interaction: PendingInteraction): boolean {
  const rawPayload = (interaction.payload ?? {}) as Record<string, unknown>;
  const input = rec(rawPayload.input);
  return (
    interaction.kind === "userInput" ||
    interaction.kind === "elicitation" ||
    rawPayload.kind === "userInput" ||
    rawPayload.kind === "elicitation" ||
    rawPayload.toolName === "AskUserQuestion" ||
    rawPayload.toolName === "ExitPlanMode" ||
    (Array.isArray(rawPayload.questions) && rawPayload.questions.length > 0) ||
    (input !== undefined && Array.isArray(input.questions))
  );
}

export interface ExtractedQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
}

/** Pull elicitation questions out of the many observed payload shapes. */
export function extractElicitationQuestions(interaction: PendingInteraction): ExtractedQuestion[] {
  const rawPayload = (interaction.payload ?? {}) as Record<string, unknown>;
  const input = rec(rawPayload.input) ?? {};
  const questions: ExtractedQuestion[] = [];

  const sourceQuestions =
    Array.isArray(rawPayload.questions) && rawPayload.questions.length > 0
      ? rawPayload.questions
      : Array.isArray(input.questions) && input.questions.length > 0
        ? input.questions
        : undefined;

  if (sourceQuestions) {
    return sourceQuestions.map((q, idx) => {
      const qRec = q === null || typeof q !== "object" ? {} : (q as Record<string, unknown>);
      const header = String(qRec.header ?? qRec.title ?? `Question ${idx + 1}`);
      const questionText = String(qRec.question ?? qRec.prompt ?? rawPayload.prompt ?? "Please choose an option:");
      const rawOpts = Array.isArray(qRec.options) ? qRec.options : [];
      const options = rawOpts.map((opt, oIdx) => {
        const oRec = opt === null || typeof opt !== "object" ? {} : (opt as Record<string, unknown>);
        const label = String(oRec.label ?? oRec.name ?? oRec.value ?? `Option ${oIdx + 1}`);
        const value = String(oRec.value ?? oRec.optionId ?? label);
        const description =
          oRec.description !== undefined && oRec.description !== null ? String(oRec.description) : undefined;
        return { value, label, ...(description !== undefined ? { description } : {}) };
      });
      return {
        id: `q${idx}`,
        header,
        question: questionText,
        options,
        multiSelect: Boolean(qRec.multiSelect),
      };
    });
  }

  if (rawPayload.toolName === "ExitPlanMode") {
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    questions.push({
      id: "q0",
      header: "Plan",
      question: plan ? `Review this implementation plan:\n\n${plan}` : "Review this implementation plan.",
      options: [
        { value: "approve", label: "Approve", description: "Exit plan mode and start implementation." },
        { value: "reject", label: "Reject", description: "Stay in plan mode." },
      ],
      multiSelect: false,
    });
    return questions;
  }

  if (Array.isArray(rawPayload.options) && rawPayload.options.length > 0) {
    questions.push({
      id: "q0",
      header: "Question",
      question: String(rawPayload.prompt ?? rawPayload.summary ?? "Please select an option:"),
      options: (rawPayload.options as Array<Record<string, unknown>>).map((opt, oIdx) => {
        const label = String(opt.label ?? opt.name ?? opt.optionId ?? `Option ${oIdx + 1}`);
        const value = String(opt.optionId ?? opt.value ?? label);
        const description =
          opt.description !== undefined && opt.description !== null ? String(opt.description) : undefined;
        return { value, label, ...(description !== undefined ? { description } : {}) };
      }),
      multiSelect: false,
    });
    return questions;
  }

  questions.push({
    id: "q0",
    header: "Question",
    question: String(rawPayload.prompt ?? rawPayload.summary ?? "Please provide input:"),
    options: [],
    multiSelect: false,
  });
  return questions;
}

export interface ElicitationCreateParams {
  sessionId: string;
  mode: "form";
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  toolCallId?: string;
}

export function buildElicitationParams(
  sessionId: string,
  questions: ExtractedQuestion[],
  rawPayload: Record<string, unknown>,
): ElicitationCreateParams {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const q of questions) {
    required.push(q.id);
    if (q.options.length > 0) {
      if (q.multiSelect === true) {
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
  return {
    sessionId,
    mode: "form",
    message,
    requestedSchema: { type: "object", properties, required },
    ...(STR(rawPayload, "toolCallId") !== undefined ? { toolCallId: STR(rawPayload, "toolCallId")! } : {}),
  };
}

export interface ElicitationAnswer {
  action?: string;
  content?: Record<string, unknown>;
}

export interface ResolvePayload {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
  optionId?: string;
}

/** Client elicitation answer → daemon resolveInteraction payload. */
export function buildElicitationResolve(
  answer: ElicitationAnswer | null,
  questions: ExtractedQuestion[],
): ResolvePayload {
  const action = answer?.action ?? "accept";
  if (action === "accept") {
    const content = answer?.content ?? {};
    // Match chosenOptionId if possible from the first question's options
    const firstAns = content[questions[0]?.id ?? "q0"] ?? Object.values(content)[0];
    let chosenOptionId: string | undefined;
    if (questions[0]?.options.length) {
      const matched = questions[0].options.find((o) => o.value === firstAns || o.label === firstAns);
      chosenOptionId = matched?.value ?? (typeof firstAns === "string" ? firstAns : undefined);
    } else if (typeof firstAns === "string") {
      chosenOptionId = firstAns;
    }
    return {
      action: "accept",
      content,
      ...(chosenOptionId !== undefined ? { optionId: chosenOptionId } : {}),
    };
  }
  return {
    action: action === "decline" ? "decline" : "cancel",
    optionId: "deny",
  };
}

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; kind: string };
  options: MappedPermissionOption[];
}

export function buildPermissionParams(
  sessionId: string,
  rawPayload: Record<string, unknown>,
  latestActiveToolCallId: string | undefined,
): PermissionRequestParams {
  const rawOptions = (rawPayload.options as Array<Record<string, unknown>> | undefined) ?? [];
  const options = mapPermissionOptions(rawOptions);
  const toolCallId = String(
    STR(rawPayload, "toolCallId") ?? latestActiveToolCallId ?? `tool_${crypto.randomUUID().slice(0, 8)}`,
  );
  const toolKind = classifyToolKind(str(rawPayload.toolName) ?? undefined);
  return {
    sessionId,
    toolCall: {
      toolCallId,
      title: str(rawPayload.summary) ?? str(rawPayload.toolName) ?? "Command execution",
      kind: toolKind,
    },
    options:
      options.length > 0
        ? options
        : [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
  };
}

/** Interaction payload type guard helpers for the server-request channel path. */
export interface PermissionServerRequestArg {
  interactionId?: string;
  toolCallId?: string;
  toolName?: string;
  options?: Array<Record<string, unknown>>;
}

export const readPermissionServerRequest = (arg: unknown): PermissionServerRequestArg => {
  const r = rec(arg);
  const options = Array.isArray(r?.options) ? (r.options as Array<Record<string, unknown>>) : undefined;
  return {
    ...(STR(r, "interactionId") !== undefined ? { interactionId: STR(r, "interactionId") } : {}),
    ...(STR(r, "toolCallId") !== undefined ? { toolCallId: STR(r, "toolCallId") } : {}),
    ...(STR(r, "toolName") !== undefined ? { toolName: STR(r, "toolName") } : {}),
    ...(options !== undefined ? { options } : {}),
  };
};

export type PendingInteractionOptionAlias = PendingInteractionOption;
export type PendingInteractionQuestionAlias = PendingInteractionQuestion;

/**
 * ACP protocol surface: initialize payload, session configOptions, prompt
 * block decoding, skill-mention rewriting, and available-commands building.
 *
 * These shapes are the drop-in wire contract with the ACP client (T3 Code) —
 * see the pre-rewrite acp/server.ts for where each quirk comes from.
 */
import { Effect, Schema } from "effect";
import { DecodeError } from "../errors.ts";
import type { DiscoveredSkill } from "../serve/session.ts";

export const BRIDGE_VERSION = "0.3.0";

export interface InitializeResult {
  protocolVersion: number;
  agentInfo: { name: string; title: string; version: string };
  agentCapabilities: {
    loadSession: boolean;
    sessionCapabilities: { resume: Record<string, never> };
    promptCapabilities: { audio: boolean; embeddedContext: boolean; image: boolean };
  };
  authMethods: Array<{ id: string; name: string; description: string }>;
}

export const buildInitializeResult = (): InitializeResult => ({
  protocolVersion: 1,
  agentInfo: { name: "zcode-serve-acp", title: "ZCode (serve daemon)", version: BRIDGE_VERSION },
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { resume: {} },
    promptCapabilities: { audio: false, embeddedContext: false, image: true },
  },
  authMethods: [
    {
      id: "zcode-cli-login",
      name: "ZCode CLI login (owned by the zcode serve daemon)",
      description: "Run `zcode login` once; the daemon reads credentials itself.",
    },
  ],
});

export const MODES = ["plan", "build", "edit", "guarded", "yolo"] as const;

export interface AcpModelOption {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: "select";
  currentValue?: string;
  options: AcpModelOption[];
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface ConfigOptionsInput {
  models: AvailableModelLike[];
  modelSelection?: ModelSelection;
  thoughtLevel?: string;
  currentMode?: string;
}

/** Structural subset of session.AvailableModel needed here (no import cycle). */
export interface AvailableModelLike {
  providerId: string;
  modelId: string;
  label?: string;
  providerLabel?: string;
  contextWindow?: number;
  reasoningLevels?: Array<{ value: string; label: string }>;
  reasoningDefaultLevel?: string;
}

/**
 * Session configOptions per the ACP client contract (the zcode-acp
 * CONFIG-OPTIONS guide t3code follows): `model` select (values
 * `providerId/modelId`), `mode` select, and `thought` select (category
 * `thought_level` — what t3code renders as the Effort panel).
 */
export function buildConfigOptions(input: ConfigOptionsInput): ConfigOption[] {
  const models = input.models;
  const sel = input.modelSelection;
  const currentModel = models.find((m) => m.providerId === sel?.providerId && m.modelId === sel?.modelId) ?? models[0];
  const currentValue = currentModel ? `${currentModel.providerId}/${currentModel.modelId}` : undefined;
  const thoughtLevels = currentModel?.reasoningLevels ?? [];
  const thoughtCurrent = input.thoughtLevel ?? currentModel?.reasoningDefaultLevel ?? thoughtLevels[0]?.value ?? "max";
  const modelOption: ConfigOption = {
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
  const modeOption: ConfigOption = {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    // REQUIRED by the ACP session-config schema — a select without currentValue
    // fails the whole configOptions parse on the client.
    currentValue: input.currentMode ?? MODES[1],
    options: MODES.map((m) => ({ value: m, name: m.charAt(0).toUpperCase() + m.slice(1) })),
  };
  const thoughtOption: ConfigOption | undefined =
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

// ---------- prompt blocks ----------

export const PromptBlock = Schema.Union([
  Schema.String,
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("image"),
    data: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
    uri: Schema.optional(Schema.String),
  }),
]);
export type PromptBlock = typeof PromptBlock.Type;

const decodePromptBlocks = Schema.decodeUnknownEffect(Schema.Array(PromptBlock));

export interface DecodedPrompt {
  text: string;
  images: Array<{ data?: string; mimeType?: string; uri?: string }>;
}

export const decodePrompt = (prompt: unknown): Effect.Effect<DecodedPrompt, DecodeError> =>
  Effect.gen(function* () {
    const blocks = yield* decodePromptBlocks(prompt ?? []).pipe(
      Effect.mapError(
        (issue) =>
          new DecodeError({
            location: "acp/prompt",
            message: `invalid prompt blocks: ${issue.message}`,
          }),
      ),
    );
    const text = blocks.map((b) => (typeof b === "string" ? b : b.type === "text" ? (b.text ?? "") : "")).join("\n");
    const images = blocks.flatMap((b) => (typeof b !== "string" && b.type === "image" ? [b] : []));
    return { text, images };
  });

/**
 * If the user triggered a skill via T3 Code's /skill:<name> syntax, format it
 * with the skill's file link so the ZCode daemon recognizes it as a skill
 * mention.
 */
export const rewriteSkillMention = (text: string, skills: DiscoveredSkill[]): string => {
  const skillMatch = /^\/skill:([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  let promptPayload = text;
  if (skillMatch) {
    const skillName = skillMatch[1]!;
    const userArg = skillMatch[2]?.trim() ?? "";
    const found = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
    if (found?.path) {
      promptPayload = `[$${found.name}](${found.path})${userArg ? ` ${userArg}` : ""}`;
    } else if (found) {
      promptPayload = `[$${found.name}]${userArg ? ` ${userArg}` : ""}`;
    }
  }
  return promptPayload;
};

/** slashCommands + `$`-prefixed skills, per T3 Code's command registry contract. */
export const buildAvailableCommands = (
  slashCommands: Array<{ name: string; description?: string }>,
  skills: DiscoveredSkill[],
): Array<{ name: string; description?: string }> => [
  ...slashCommands.map((c) => ({
    name: c.name,
    ...(c.description !== undefined ? { description: c.description } : {}),
  })),
  ...skills.map((s) => ({
    name: `$${s.name}`,
    ...(s.description !== undefined ? { description: s.description } : {}),
  })),
];

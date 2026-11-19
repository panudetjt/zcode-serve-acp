/**
 * Model advertisement for ACP `session/new`.
 *
 * Primary source: the daemon itself — `zcode-session.createSession` returns
 * `settings.model.available` (the CLI resolves its own entitlements, so the
 * picker problem of the old bridge disappears).
 *
 * Fallback (CLI 0.17.1 model-provisioning bug, per PR #34713 docs): enumerate
 * the CLI's bundled provider table (`~/.zcode/v2/runtime/provider/bundled/
 * zcode-builtin.json`) filtered by OAuth-selection presence in setting.json —
 * the #33684 extraction: presence of `oauth:<family>:access_token` in the
 * store proves the login; no decryption needed.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AvailableModel } from "./serve/session.ts";

export interface AcpiModel {
  modelId: string;
  name: string;
  /** Gray secondary label next to the name in the picker (the account/plan). */
  description?: string;
  _meta?: {
    supportsReasoningEffort: boolean;
    reasoningEffort: string;
    reasoningEfforts: Array<{ value: string; label: string }>;
  };
}

export function modelsToAcp(
  models: AvailableModel[],
  current?: string,
): { currentModelId: string | null; availableModels: AcpiModel[] } {
  const availableModels: AcpiModel[] = models.map((m) => {
    const modelId = `${m.providerId}/${m.modelId}`;
    const name = m.providerLabel ? `${m.label ?? m.modelId} (${m.providerLabel})` : (m.label ?? m.modelId);
    const reasoningLevels = (m.reasoningLevels ?? []).map((l) => ({
      value: l.value,
      label: l.label ? l.label.charAt(0).toUpperCase() + l.label.slice(1) : l.value,
    }));
    const defaultEffort = m.reasoningDefaultLevel ?? reasoningLevels[0]?.value ?? "max";
    return {
      modelId,
      name,
      ...(m.providerLabel ? { description: m.providerLabel } : {}),
      _meta: {
        supportsReasoningEffort: reasoningLevels.length > 0,
        reasoningEffort: defaultEffort,
        reasoningEfforts: reasoningLevels,
      },
    };
  });
  let currentId: string | null = null;
  if (current !== undefined && current !== "") {
    currentId =
      availableModels.find(
        (m) => m.modelId === current || m.modelId.endsWith(`/${current}`)
      )?.modelId ?? null;
  }
  if (!currentId && availableModels.length > 0) {
    currentId = availableModels[0].modelId;
  }
  return { currentModelId: currentId, availableModels };
}

export interface FallbackModelsResult {
  models: AvailableModel[];
}

/** Presence-check fallback — never decrypts anything. */
export function fallbackModels(env: NodeJS.ProcessEnv = process.env): FallbackModelsResult {
  const root = env.ZCODE_DATA_BASE_DIR ?? path.join(env.HOME ?? os.homedir(), "");
  const v2 = path.join(root, ".zcode", "v2");
  const tablePath = path.join(v2, "runtime", "provider", "bundled", "zcode-builtin.json");
  const settingPath = path.join(v2, "setting.json");
  const credsPath = path.join(v2, "credentials.json");
  const out: AvailableModel[] = [];
  if (!existsSync(tablePath) || !existsSync(settingPath) || !existsSync(credsPath)) return { models: out };
  try {
    const setting = JSON.parse(readFileSync(settingPath, "utf8")) as {
      providerFamilyConnectionSelections?: Record<string, { kind?: string }>;
      modelProviderFamilyModes?: Record<string, string>;
    };
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, unknown>;
    const families: string[] = [];
    for (const [family, selection] of Object.entries(setting.providerFamilyConnectionSelections ?? {})) {
      if (selection?.kind !== "individual-coding-plan") continue;
      if (setting.modelProviderFamilyModes?.[family] === "apiKey") continue;
      const token = creds[`oauth:${family}:access_token`];
      if (typeof token !== "string" || token.length === 0) continue;
      families.push(family);
    }
    const table = JSON.parse(readFileSync(tablePath, "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: Array<{
            providerId?: string;
            config?: { access?: { type?: string; mode?: string; accountType?: string }; builtinModelIds?: string[] };
          }>;
        };
      };
    };
    for (const rule of table.config?.providerConfigRules?.providerRules ?? []) {
      const access = rule.config?.access;
      if (access?.type !== "zhipu-account" || access.mode !== "individual-coding-plan") continue;
      if (!families.includes(access.accountType ?? "")) continue;
      for (const modelId of rule.config?.builtinModelIds ?? []) {
        out.push({
          providerId: rule.providerId ?? "",
          modelId,
          label: modelId,
          providerLabel: `${(access.accountType ?? "").toUpperCase()} Coding Plan`,
          reasoningLevels: [
            { value: "low", label: "low" },
            { value: "high", label: "high" },
            { value: "max", label: "max" },
          ],
          reasoningDefaultLevel: "max",
        });
      }
    }
  } catch {
    /* fall through with whatever we have */
  }
  return { models: out };
}

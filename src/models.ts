/**
 * Model advertisement for ACP `session/new`.
 *
 * Primary source: the daemon itself — `zcode-session.createSession` returns
 * `settings.model.available` (the CLI resolves its own entitlements, so the
 * picker problem of the old bridge disappears).
 *
 * Fallback (CLI 0.17.1 model-provisioning bug, per PR #34713 docs): enumerate
 * the CLI's active runtime provider table (`~/.zcode/v2/runtime/provider/
 * <platform>/<version>/endpoint-<hash>/zcode-builtin.json` with highest
 * revision, falling back to the bundled baseline `bundled/zcode-builtin.json`)
 * filtered by OAuth-selection presence in setting.json — the #33684 extraction:
 * presence of `oauth:<family>:access_token` in the store proves the login;
 * no decryption needed. Reads go through the platform FileSystem service;
 * any failure yields no fallback models (never throws).
 */
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { DecodeError, renderError } from "./errors.ts"
import type { AvailableModel } from "./serve/session.ts"
import { envDataOverride, envHome } from "./config.ts"

export interface AcpiModel {
  modelId: string
  name: string
  /** Gray secondary label next to the name in the picker (the account/plan). */
  description?: string
  _meta?: {
    supportsReasoningEffort: boolean
    reasoningEffort: string
    reasoningEfforts: Array<{ value: string; label: string }>
  }
}

export interface ModelsToAcpResult {
  currentModelId: string | null
  availableModels: AcpiModel[]
}

export function modelsToAcp(models: AvailableModel[], current?: string): ModelsToAcpResult {
  const availableModels: AcpiModel[] = models.map((m) => {
    const modelId = `${m.providerId}/${m.modelId}`
    const name = m.providerLabel ? `${m.label ?? m.modelId} (${m.providerLabel})` : (m.label ?? m.modelId)
    const reasoningLevels = (m.reasoningLevels ?? []).map((l) => ({
      value: l.value,
      label: l.label ? l.label.charAt(0).toUpperCase() + l.label.slice(1) : l.value
    }))
    const defaultEffort = m.reasoningDefaultLevel ?? reasoningLevels[0]?.value ?? "max"
    return {
      modelId,
      name,
      ...(m.providerLabel ? { description: m.providerLabel } : {}),
      _meta: {
        supportsReasoningEffort: reasoningLevels.length > 0,
        reasoningEffort: defaultEffort,
        reasoningEfforts: reasoningLevels
      }
    }
  })
  let currentId: string | null = null
  if (current !== undefined && current !== "") {
    currentId = availableModels.find((m) => m.modelId === current || m.modelId.endsWith(`/${current}`))?.modelId ?? null
  }
  if (!currentId && availableModels.length > 0) {
    currentId = availableModels[0]?.modelId ?? null
  }
  return { currentModelId: currentId, availableModels }
}

const ProviderSetting = Schema.Struct({
  providerFamilyConnectionSelections: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ kind: Schema.optional(Schema.String) }))
  ),
  modelProviderFamilyModes: Schema.optional(Schema.Record(Schema.String, Schema.String))
})
const ProviderCredentials = Schema.Record(Schema.String, Schema.Unknown)
const ProviderTable = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      providerConfigRules: Schema.optional(
        Schema.Struct({
          providerRules: Schema.optional(
            Schema.Array(
              Schema.Struct({
                providerId: Schema.optional(Schema.String),
                config: Schema.optional(
                  Schema.Struct({
                    access: Schema.optional(
                      Schema.Struct({
                        type: Schema.optional(Schema.String),
                        mode: Schema.optional(Schema.String),
                        accountType: Schema.optional(Schema.String)
                      })
                    ),
                    builtinModelIds: Schema.optional(Schema.Array(Schema.String))
                  })
                )
              })
            )
          )
        })
      )
    })
  )
})

const decodeSetting = Schema.decodeUnknownSync(ProviderSetting)
const decodeCreds = Schema.decodeUnknownSync(ProviderCredentials)
const decodeTable = Schema.decodeUnknownSync(ProviderTable)

const readJson = (fs: FileSystem, file: string): Effect.Effect<unknown | undefined> =>
  fs.readFileString(file).pipe(
    Effect.map((text) => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return undefined
      }
    }),
    Effect.orElseSucceed(() => undefined)
  )

/**
 * Resolves the raw provider table JSON from `<v2>/runtime/provider/`.
 * Discovers active downloaded releases under `<platform>/<version>/endpoint-<hash>/zcode-builtin.json`
 * alongside the bundled baseline (`bundled/zcode-builtin.json`), selecting the candidate with the highest revision.
 */
export const resolveActiveProviderTable = (
  fs: FileSystem,
  v2: string
): Effect.Effect<unknown | undefined> =>
  Effect.gen(function* () {
    const providerDir = `${v2}/runtime/provider`
    const bundledPath = `${providerDir}/bundled/zcode-builtin.json`

    const entries =
      typeof fs.readDirectory === "function"
        ? yield* fs.readDirectory(providerDir, { recursive: true }).pipe(Effect.orElseSucceed(() => []))
        : []

    const candidateFiles = entries
      .filter((e) => e.endsWith("zcode-builtin.json"))
      .map((e) => `${providerDir}/${e}`)

    if (!candidateFiles.includes(bundledPath)) {
      candidateFiles.push(bundledPath)
    }

    let bestTable: unknown | undefined = undefined
    let highestRevision = -1

    for (const file of candidateFiles) {
      const raw = yield* readJson(fs, file)
      if (typeof raw === "object" && raw !== null) {
        const rev = "revision" in raw && typeof raw.revision === "number" ? raw.revision : 0
        if (rev > highestRevision) {
          highestRevision = rev
          bestTable = raw
        }
      }
    }

    if (bestTable === undefined) {
      bestTable = yield* readJson(fs, bundledPath)
    }

    return bestTable
  })

/** Presence-check fallback — never decrypts anything. */
export const fallbackModels: Effect.Effect<AvailableModel[], never, FileSystem> = Effect.gen(function* () {
  const root = envDataOverride() ?? envHome() ?? ""
  const v2 = `${root}/.zcode/v2`
  const settingPath = `${v2}/setting.json`
  const credsPath = `${v2}/credentials.json`
  const fs = yield* FileSystem

  const [settingRaw, credsRaw, tableRaw] = yield* Effect.all([
    readJson(fs, settingPath),
    readJson(fs, credsPath),
    resolveActiveProviderTable(fs, v2)
  ])
  if (settingRaw === undefined || credsRaw === undefined || tableRaw === undefined) return []

  // decodeUnknownSync throws on wrong shapes — route the throw through the
  // typed channel (agent-patterns/effect.md: Effect.try carries a `catch`)
  // so the best-effort pipe below can swallow it.
  const decode = <A>(location: string, run: () => A): Effect.Effect<A, DecodeError> =>
    Effect.try({
      try: run,
      catch: (cause) => new DecodeError({ location, message: renderError(cause), cause })
    })
  const setting = yield* decode("models/setting", () => decodeSetting(settingRaw))
  const creds = yield* decode("models/credentials", () => decodeCreds(credsRaw))
  const table = yield* decode("models/provider-table", () => decodeTable(tableRaw))

  const families: string[] = []
  for (const [family, selection] of Object.entries(setting.providerFamilyConnectionSelections ?? {})) {
    if (selection?.kind !== "individual-coding-plan") continue
    if (setting.modelProviderFamilyModes?.[family] === "apiKey") continue
    const token = creds[`oauth:${family}:access_token`]
    if (typeof token !== "string" || token.length === 0) continue
    families.push(family)
  }

  const out: AvailableModel[] = []
  for (const rule of table.config?.providerConfigRules?.providerRules ?? []) {
    const access = rule.config?.access
    if (access?.type !== "zhipu-account" || access.mode !== "individual-coding-plan") continue
    if (!families.includes(access.accountType ?? "")) continue
    for (const modelId of rule.config?.builtinModelIds ?? []) {
      out.push({
        providerId: rule.providerId ?? "",
        modelId,
        label: modelId,
        providerLabel: `${(access.accountType ?? "").toUpperCase()} Coding Plan`,
        reasoningLevels: [
          { value: "low", label: "low" },
          { value: "high", label: "high" },
          { value: "max", label: "max" }
        ],
        reasoningDefaultLevel: "max"
      })
    }
  }
  return out
}).pipe(
  // The fallback path is best-effort: any decode/read failure yields nothing.
  Effect.orElseSucceed((): AvailableModel[] => [])
)

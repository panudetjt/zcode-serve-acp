import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { fallbackModels, modelsToAcp, resolveActiveProviderTable } from "../src/models.ts"
import {
  buildAvailableCommands,
  buildConfigOptions,
  buildInitializeResult,
  decodePrompt,
  rewriteSkillMention
} from "../src/acp/protocol.ts"
import { AcpServer } from "../src/acp/server.ts"
import { ClientRequestError } from "../src/errors.ts"
import { Log } from "../src/log.ts"
import type { AvailableModel } from "../src/serve/session.ts"

const sampleModels: AvailableModel[] = [
  {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    providerLabel: "Z.AI Individual Coding Plan",
    reasoningLevels: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" }
    ],
    reasoningDefaultLevel: "max"
  },
  {
    providerId: "account:zai-offpeak-idle-plan",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    providerLabel: "Z.AI Idle plan",
    reasoningLevels: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" }
    ],
    reasoningDefaultLevel: "max"
  }
]

describe("modelsToAcp", () => {
  it("formats model names with account/plan label for picker visibility", () => {
    const res = modelsToAcp(sampleModels)
    expect(res.availableModels).toHaveLength(2)
    expect(res.availableModels[0]!.name).toBe("GLM-5.3 (Z.AI Individual Coding Plan)")
    expect(res.availableModels[1]!.name).toBe("GLM-5.3 (Z.AI Idle plan)")
    expect(res.availableModels[0]!.description).toBe("Z.AI Individual Coding Plan")
  })

  it("provides _meta reasoning effort descriptor metadata matching T3 Code schema", () => {
    const res = modelsToAcp(sampleModels)
    const meta0 = res.availableModels[0]!._meta
    expect(meta0).toBeDefined()
    expect(meta0?.supportsReasoningEffort).toBe(true)
    expect(meta0?.reasoningEffort).toBe("max")
    expect(meta0?.reasoningEfforts).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" }
    ])
  })

  it("resolves currentModelId correctly", () => {
    const res = modelsToAcp(sampleModels, "account:zai-offpeak-idle-plan/GLM-5.3")
    expect(res.currentModelId).toBe("account:zai-offpeak-idle-plan/GLM-5.3")
  })
})

describe("initialize agentCapabilities", () => {
  it("advertises image prompt support and session resume/load in initialize agentCapabilities", async () => {
    const acp = AcpServer.make({
      sessions: { create: () => Effect.die("not used") } as never,
      log: Log.of({ debug: () => Effect.void, warn: () => Effect.void, debugSync: () => {} }),
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.fail(new ClientRequestError({ message: "not used" })),
      fallbackModels: Effect.succeed([])
    })
    const init = (await Effect.runPromise(acp.handle("initialize", {}))) as ReturnType<typeof buildInitializeResult>
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true)
    expect(init.agentCapabilities?.loadSession).toBe(true)
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined()
  })
})

describe("skills advertising and prompt formatting", () => {
  it("formats /skill:<name> into [$name](path) skill mention for daemon", () => {
    const skills = [
      { name: "tdd", description: "Test driven development", path: "/home/jame/.zcode/skills/tdd/SKILL.md" },
      { name: "analyze-logs", description: "Analyze logs" }
    ]
    expect(rewriteSkillMention("/skill:tdd", skills)).toBe("[$tdd](/home/jame/.zcode/skills/tdd/SKILL.md)")
    expect(rewriteSkillMention("/skill:tdd write tests for auth", skills)).toBe(
      "[$tdd](/home/jame/.zcode/skills/tdd/SKILL.md) write tests for auth"
    )
    expect(rewriteSkillMention("/skill:analyze-logs", skills)).toBe("[$analyze-logs]")
    expect(rewriteSkillMention("regular prompt", skills)).toBe("regular prompt")
  })

  it("advertises skills with $ prefix per T3 Code normalizeAcpRegistryCommands contract", () => {
    const slashCommands = [{ name: "goal", description: "Set goal" }]
    const skills = [{ name: "tdd", description: "TDD skill" }]
    const availableCommands = buildAvailableCommands(slashCommands, skills)
    expect(availableCommands).toEqual([
      { name: "goal", description: "Set goal" },
      { name: "$tdd", description: "TDD skill" }
    ])

    // T3 Code's parsing expectation: $-prefixed names are skills.
    const seen = new Set<string>()
    const parsedSlash: unknown[] = []
    const parsedSkills: unknown[] = []
    for (const cmd of availableCommands) {
      if (cmd.name.startsWith("$")) {
        parsedSkills.push({ name: cmd.name.slice(1), description: cmd.description })
      } else {
        parsedSlash.push({ name: cmd.name, description: cmd.description })
      }
      seen.add(cmd.name)
    }
    expect(parsedSkills).toEqual([{ name: "tdd", description: "TDD skill" }])
    expect(parsedSlash).toEqual([{ name: "goal", description: "Set goal" }])
    expect(seen.size).toBe(availableCommands.length)
  })
})

describe("fallbackModels", () => {
  it("returns empty array when setting/credentials files are missing", async () => {
    const fakeFs = {
      readFileString: () => Effect.fail(new Error("ENOENT"))
    } as unknown as FileSystem
    const res = await Effect.runPromise(fallbackModels.pipe(Effect.provideService(FileSystem, fakeFs)))
    expect(res).toEqual([])
  })

  it("handles corrupt JSON in files gracefully", async () => {
    const fakeFs = {
      readFileString: (path: string) => {
        if (path.includes("setting.json")) return Effect.succeed("{not valid json")
        return Effect.succeed("{}")
      }
    } as unknown as FileSystem
    const res = await Effect.runPromise(fallbackModels.pipe(Effect.provideService(FileSystem, fakeFs)))
    expect(res).toEqual([])
  })

  it("yields no fallback models when a file decodes to the wrong shape", async () => {
    // decodeUnknownSync throws on a structurally wrong document — the
    // best-effort pipe must swallow it into an empty list.
    const fakeFs = {
      readFileString: (path: string) => {
        if (path.includes("setting.json")) return Effect.succeed("[1, 2, 3]")
        return Effect.succeed("{}")
      }
    } as unknown as FileSystem
    const res = await Effect.runPromise(fallbackModels.pipe(Effect.provideService(FileSystem, fakeFs)))
    expect(res).toEqual([])
  })

  it("decodes fallback models when files are present and match individual-coding-plan", async () => {
    const settingJson = JSON.stringify({
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" }
      },
      modelProviderFamilyModes: {}
    })
    const credsJson = JSON.stringify({
      "oauth:zai:access_token": "valid-token-123"
    })
    const tableJson = JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "zai-provider",
              config: {
                access: {
                  type: "zhipu-account",
                  mode: "individual-coding-plan",
                  accountType: "zai"
                },
                builtinModelIds: ["GLM-5.3"]
              }
            }
          ]
        }
      }
    })

    const fakeFs = {
      readFileString: (path: string) => {
        if (path.includes("setting.json")) return Effect.succeed(settingJson)
        if (path.includes("credentials.json")) return Effect.succeed(credsJson)
        if (path.includes("zcode-builtin.json")) return Effect.succeed(tableJson)
        return Effect.fail(new Error("ENOENT"))
      }
    } as unknown as FileSystem

    const res = await Effect.runPromise(fallbackModels.pipe(Effect.provideService(FileSystem, fakeFs)))
    expect(res.length).toBe(1)
    expect(res[0]?.modelId).toBe("GLM-5.3")
    expect(res[0]?.providerId).toBe("zai-provider")
  })

  it("discovers the active runtime provider table with highest revision over bundled", async () => {
    const settingJson = JSON.stringify({
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" }
      },
      modelProviderFamilyModes: {}
    })
    const credsJson = JSON.stringify({
      "oauth:zai:access_token": "valid-token-123"
    })
    const bundledTableJson = JSON.stringify({
      revision: 44,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "account:zai-individual-coding-plan",
              config: {
                access: {
                  type: "zhipu-account",
                  mode: "individual-coding-plan",
                  accountType: "zai"
                },
                builtinModelIds: ["GLM-5.3"]
              }
            }
          ]
        }
      }
    })
    const activeTableJson = JSON.stringify({
      revision: 48,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "account:zai-individual-coding-plan",
              config: {
                access: {
                  type: "zhipu-account",
                  mode: "individual-coding-plan",
                  accountType: "zai"
                },
                builtinModelIds: ["GLM-5.4", "GLM-5.3"]
              }
            }
          ]
        }
      }
    })

    const fakeFs = {
      readDirectory: () =>
        Effect.succeed([
          "bundled/zcode-builtin.json",
          "linux-x86_64/3.19.1/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json"
        ]),
      readFileString: (path: string) => {
        if (path.includes("setting.json")) return Effect.succeed(settingJson)
        if (path.includes("credentials.json")) return Effect.succeed(credsJson)
        if (path.includes("3.19.1")) return Effect.succeed(activeTableJson)
        if (path.includes("bundled")) return Effect.succeed(bundledTableJson)
        return Effect.fail(new Error("ENOENT"))
      }
    } as unknown as FileSystem

    const res = await Effect.runPromise(fallbackModels.pipe(Effect.provideService(FileSystem, fakeFs)))
    expect(res.length).toBe(2)
    expect(res[0]?.modelId).toBe("GLM-5.4")
    expect(res[1]?.modelId).toBe("GLM-5.3")
    expect(res[0]?.providerId).toBe("account:zai-individual-coding-plan")
  })

  it("falls back to bundled table when active runtime entries are missing or empty", async () => {
    const settingJson = JSON.stringify({
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" }
      },
      modelProviderFamilyModes: {}
    })
    const credsJson = JSON.stringify({
      "oauth:zai:access_token": "valid-token-123"
    })
    const bundledTableJson = JSON.stringify({
      revision: 44,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "account:zai-individual-coding-plan",
              config: {
                access: {
                  type: "zhipu-account",
                  mode: "individual-coding-plan",
                  accountType: "zai"
                },
                builtinModelIds: ["GLM-5.3"]
              }
            }
          ]
        }
      }
    })

    const fakeFs = {
      readDirectory: () => Effect.succeed([]),
      readFileString: (path: string) => {
        if (path.includes("setting.json")) return Effect.succeed(settingJson)
        if (path.includes("credentials.json")) return Effect.succeed(credsJson)
        if (path.includes("bundled/zcode-builtin.json")) return Effect.succeed(bundledTableJson)
        return Effect.fail(new Error("ENOENT"))
      }
    } as unknown as FileSystem

    const res = await Effect.runPromise(fallbackModels.pipe(Effect.provideService(FileSystem, fakeFs)))
    expect(res.length).toBe(1)
    expect(res[0]?.modelId).toBe("GLM-5.3")
  })

  it("resolves the table object with the highest revision directly", async () => {
    const fakeFs = {
      readDirectory: () =>
        Effect.succeed([
          "bundled/zcode-builtin.json",
          "linux-x86_64/3.19.1/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json"
        ]),
      readFileString: (path: string) => {
        if (path.includes("3.19.1")) return Effect.succeed(JSON.stringify({ revision: 48, name: "active" }))
        if (path.includes("bundled")) return Effect.succeed(JSON.stringify({ revision: 44, name: "bundled" }))
        return Effect.fail(new Error("ENOENT"))
      }
    } as unknown as FileSystem

    const table = (await Effect.runPromise(resolveActiveProviderTable(fakeFs, "/root/.zcode/v2"))) as {
      revision: number
      name: string
    }
    expect(table.revision).toBe(48)
    expect(table.name).toBe("active")
  })
})

describe("decodePrompt", () => {
  it("decodes string and text blocks", async () => {
    const res = await Effect.runPromise(decodePrompt(["hello world", { type: "text", text: "from block" }]))
    expect(res.text).toBe("hello world\nfrom block")
    expect(res.images).toEqual([])
  })

  it("decodes image blocks", async () => {
    const imgBlock = { type: "image", data: "base64...", mimeType: "image/png" }
    const res = await Effect.runPromise(decodePrompt([imgBlock]))
    expect(res.images.length).toBe(1)
    expect(res.images[0]?.mimeType).toBe("image/png")
  })

  it("fails with DecodeError on invalid prompt blocks", async () => {
    const result = await Effect.runPromise(decodePrompt([{ type: "unknown-type" }]).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("DecodeError")
      expect(result.failure.location).toBe("acp/prompt")
    }
  })
})

describe("buildConfigOptions", () => {
  it("omits thought option when reasoningLevels is empty or undefined", () => {
    const options = buildConfigOptions({
      models: [
        {
          providerId: "prov",
          modelId: "m1",
          reasoningLevels: []
        }
      ],
      currentMode: "code"
    })
    expect(options.some((o) => o.id === "reasoning")).toBe(false)
  })

  it("handles reasoning level without label and falls back to value", () => {
    const options = buildConfigOptions({
      models: [
        {
          providerId: "prov",
          modelId: "m1",
          reasoningLevels: [{ value: "high", label: "" }]
        }
      ],
      thoughtLevel: "high"
    })
    const reasoning = options.find((o) => o.id === "reasoning")
    expect(reasoning).toBeDefined()
    expect(reasoning?.options?.[0]?.name).toBe("high")
  })

  it("handles empty models list gracefully", () => {
    const options = buildConfigOptions({
      models: []
    })
    expect(options.length).toBe(2)
    expect(options[0]?.id).toBe("model")
    expect(options[0]?.currentValue).toBeUndefined()
    expect(options[1]?.id).toBe("mode")
  })
})

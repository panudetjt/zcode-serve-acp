import { describe, expect, it } from "bun:test";
import { modelsToAcp } from "../src/models.ts";
import { buildAvailableCommands, buildInitializeResult, rewriteSkillMention } from "../src/acp/protocol.ts";
import { AcpServer } from "../src/acp/server.ts";
import { Effect } from "effect";
import { Log } from "../src/log.ts";
import type { AvailableModel } from "../src/serve/session.ts";

void Log;

const sampleModels: AvailableModel[] = [
  {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    providerLabel: "Z.AI Individual Coding Plan",
    reasoningLevels: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" },
    ],
    reasoningDefaultLevel: "max",
  },
  {
    providerId: "account:zai-offpeak-idle-plan",
    modelId: "GLM-5.3",
    label: "GLM-5.3",
    providerLabel: "Z.AI Idle plan",
    reasoningLevels: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
      { value: "max", label: "max" },
    ],
    reasoningDefaultLevel: "max",
  },
];

describe("modelsToAcp", () => {
  it("formats model names with account/plan label for picker visibility", () => {
    const res = modelsToAcp(sampleModels);
    expect(res.availableModels).toHaveLength(2);
    expect(res.availableModels[0]!.name).toBe("GLM-5.3 (Z.AI Individual Coding Plan)");
    expect(res.availableModels[1]!.name).toBe("GLM-5.3 (Z.AI Idle plan)");
    expect(res.availableModels[0]!.description).toBe("Z.AI Individual Coding Plan");
  });

  it("provides _meta reasoning effort descriptor metadata matching T3 Code schema", () => {
    const res = modelsToAcp(sampleModels);
    const meta0 = res.availableModels[0]!._meta;
    expect(meta0).toBeDefined();
    expect(meta0?.supportsReasoningEffort).toBe(true);
    expect(meta0?.reasoningEffort).toBe("max");
    expect(meta0?.reasoningEfforts).toEqual([
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
    ]);
  });

  it("resolves currentModelId correctly", () => {
    const res = modelsToAcp(sampleModels, "account:zai-offpeak-idle-plan/GLM-5.3");
    expect(res.currentModelId).toBe("account:zai-offpeak-idle-plan/GLM-5.3");
  });
});

describe("initialize agentCapabilities", () => {
  it("advertises image prompt support and session resume/load in initialize agentCapabilities", async () => {
    const acp = AcpServer.make({
      sessions: { create: () => Effect.die("not used") } as never,
      log: Log.of({ debug: () => Effect.void, warn: () => Effect.void }),
      emitNotification: () => Effect.void,
      clientRequest: () => Effect.fail(new Error("not used")),
      fallbackModels: Effect.succeed([]),
    });
    const init = (await Effect.runPromise(acp.handle("initialize", {}))) as ReturnType<typeof buildInitializeResult>;
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
  });
});

describe("skills advertising and prompt formatting", () => {
  it("formats /skill:<name> into [$name](path) skill mention for daemon", () => {
    const skills = [
      { name: "tdd", description: "Test driven development", path: "/home/jame/.zcode/skills/tdd/SKILL.md" },
      { name: "analyze-logs", description: "Analyze logs" },
    ];
    expect(rewriteSkillMention("/skill:tdd", skills)).toBe("[$tdd](/home/jame/.zcode/skills/tdd/SKILL.md)");
    expect(rewriteSkillMention("/skill:tdd write tests for auth", skills)).toBe(
      "[$tdd](/home/jame/.zcode/skills/tdd/SKILL.md) write tests for auth",
    );
    expect(rewriteSkillMention("/skill:analyze-logs", skills)).toBe("[$analyze-logs]");
    expect(rewriteSkillMention("regular prompt", skills)).toBe("regular prompt");
  });

  it("advertises skills with $ prefix per T3 Code normalizeAcpRegistryCommands contract", () => {
    const slashCommands = [{ name: "goal", description: "Set goal" }];
    const skills = [{ name: "tdd", description: "TDD skill" }];
    const availableCommands = buildAvailableCommands(slashCommands, skills);
    expect(availableCommands).toEqual([
      { name: "goal", description: "Set goal" },
      { name: "$tdd", description: "TDD skill" },
    ]);

    // T3 Code's parsing expectation: $-prefixed names are skills.
    const seen = new Set<string>();
    const parsedSlash: unknown[] = [];
    const parsedSkills: unknown[] = [];
    for (const cmd of availableCommands) {
      if (cmd.name.startsWith("$")) {
        parsedSkills.push({ name: cmd.name.slice(1), description: cmd.description });
      } else {
        parsedSlash.push({ name: cmd.name, description: cmd.description });
      }
      seen.add(cmd.name);
    }
    expect(parsedSkills).toEqual([{ name: "tdd", description: "TDD skill" }]);
    expect(parsedSlash).toEqual([{ name: "goal", description: "Set goal" }]);
    expect(seen.size).toBe(availableCommands.length);
  });
});

import { describe, expect, it } from "bun:test";
import { modelsToAcp, type AvailableModel } from "../src/models.ts";

describe("modelsToAcp", () => {
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

  it("formats model names with account/plan label for picker visibility", () => {
    const res = modelsToAcp(sampleModels);
    expect(res.availableModels).toHaveLength(2);
    expect(res.availableModels[0].name).toBe("GLM-5.3 (Z.AI Individual Coding Plan)");
    expect(res.availableModels[1].name).toBe("GLM-5.3 (Z.AI Idle plan)");
    expect(res.availableModels[0].description).toBe("Z.AI Individual Coding Plan");
  });

  it("provides _meta reasoning effort descriptor metadata matching T3 Code schema", () => {
    const res = modelsToAcp(sampleModels);
    const meta0 = res.availableModels[0]._meta;
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

  it("advertises image prompt support and session resume/load in initialize agentCapabilities", async () => {
    const { AcpServer } = await import("../src/acp/server.ts");
    const server = new AcpServer(() => {});
    const init = (await server.handle("initialize", {}, async () => ({}))) as {
      agentCapabilities?: {
        loadSession?: boolean;
        sessionCapabilities?: { resume?: unknown };
        promptCapabilities?: { image?: boolean };
      };
    };
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
  });
});

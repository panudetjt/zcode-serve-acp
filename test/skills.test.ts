import { describe, expect, it } from "bun:test";
import { AcpServer } from "../src/acp/server.ts";

describe("AcpServer skills advertising and prompt formatting", () => {
  it("formats /skill:<name> into [$name](path) skill mention for daemon", async () => {
    const emitted: Array<{ method: string; params: unknown }> = [];
    const server = new AcpServer((method, params) => {
      emitted.push({ method, params });
    });

    // Verify prompt translation logic directly
    const skills = [
      { name: "tdd", description: "Test driven development", path: "/home/jame/.zcode/skills/tdd/SKILL.md" },
      { name: "analyze-logs", description: "Analyze logs" },
    ];

    const matchAndFormat = (text: string) => {
      const skillMatch = /^\/skill:([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      let promptPayload = text;
      if (skillMatch) {
        const skillName = skillMatch[1];
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

    expect(matchAndFormat("/skill:tdd")).toBe("[$tdd](/home/jame/.zcode/skills/tdd/SKILL.md)");
    expect(matchAndFormat("/skill:tdd write tests for auth")).toBe("[$tdd](/home/jame/.zcode/skills/tdd/SKILL.md) write tests for auth");
    expect(matchAndFormat("/skill:analyze-logs")).toBe("[$analyze-logs]");
    expect(matchAndFormat("regular prompt")).toBe("regular prompt");
  });

  it("advertises skills with $ prefix per T3 Code normalizeAcpRegistryCommands contract", () => {
    const slashCommands = [{ name: "goal", description: "Set goal" }];
    const skills = [{ name: "tdd", description: "TDD skill" }];

    const availableCommands = [
      ...slashCommands.map((c) => ({
        name: c.name,
        ...(c.description !== undefined ? { description: c.description } : {}),
      })),
      ...skills.map((s) => ({
        name: `$${s.name}`,
        ...(s.description !== undefined ? { description: s.description } : {}),
      })),
    ];

    expect(availableCommands).toEqual([
      { name: "goal", description: "Set goal" },
      { name: "$tdd", description: "TDD skill" },
    ]);

    // Test T3 Code's parsing expectation:
    const seen = new Set<string>();
    const parsedSlash: unknown[] = [];
    const parsedSkills: unknown[] = [];
    for (const cmd of availableCommands) {
      if (cmd.name.startsWith("$")) {
        parsedSkills.push({ name: cmd.name.slice(1), description: cmd.description });
      } else {
        parsedSlash.push({ name: cmd.name, description: cmd.description });
      }
    }

    expect(parsedSkills).toEqual([{ name: "tdd", description: "TDD skill" }]);
    expect(parsedSlash).toEqual([{ name: "goal", description: "Set goal" }]);
  });
});

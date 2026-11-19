import { describe, expect, it } from "bun:test";
import { AcpServer } from "../src/acp/server.ts";

describe("AcpServer elicitation handling", () => {
  it("translates userInput pending interaction to elicitation/create and maps response to resolveInteraction", async () => {
    const emitted: Array<{ method: string; params: unknown }> = [];
    const server = new AcpServer((method, params) => {
      emitted.push({ method, params });
    });

    let clientRequestMethod = "";
    let clientRequestParams: unknown;

    server.clientRequest = async (method: string, params: unknown) => {
      clientRequestMethod = method;
      clientRequestParams = params;
      return {
        action: "accept",
        content: {
          q0: "เปิด MCP browser-use ให้ผม (Recommended)",
        },
      };
    };

    let resolvedInteractionId = "";
    let resolvedAnswer: unknown;

    // Mock session
    const mockBridge = {
      serve: {
        resolveInteraction: async (id: string, ans: unknown) => {
          resolvedInteractionId = id;
          resolvedAnswer = ans;
          return { status: "accepted" };
        },
      },
      translator: {
        getLatestActiveToolCallId: () => undefined,
      },
      handledInteractions: new Set<string>(),
    };

    // Inject session
    (server as unknown as { sessions: Map<string, unknown> }).sessions.set("sess_123", mockBridge);

    // Call handlePendingInteraction
    await (server as unknown as {
      handlePendingInteraction: (sessionId: string, interaction: unknown) => Promise<void>;
    }).handlePendingInteraction("sess_123", {
      interactionId: "interact_ask_999",
      kind: "userInput",
      payload: {
        kind: "userInput",
        prompt: "ทางแก้ที่เป็นไปได้ ขอให้คุณเลือกให้ทีครับ:",
        questions: [
          {
            header: "Unblock",
            question: "Browser tool ที่ใช้ capture ไม่มีใน session นี้ — จะให้ผมเดินหน้าทางไหน?",
            multiSelect: false,
            options: [
              {
                label: "เปิด MCP browser-use ให้ผม (Recommended)",
                value: "เปิด MCP browser-use ให้ผม (Recommended)",
                description: "เช็ค MCP server ของ ZCode",
              },
              {
                label: "อนุญาต shell ให้ใช้ browser client",
                value: "อนุญาต shell ให้ใช้ browser client",
                description: "ผมจะใช้ shell",
              },
            ],
          },
        ],
      },
    });

    // Verify elicitation/create was called on client
    expect(clientRequestMethod).toBe("elicitation/create");
    const elicitationParams = clientRequestParams as {
      sessionId: string;
      mode: string;
      message: string;
      requestedSchema: {
        type: string;
        properties: Record<string, { type: string; title: string; description: string; oneOf?: unknown[] }>;
        required: string[];
      };
    };

    expect(elicitationParams.sessionId).toBe("sess_123");
    expect(elicitationParams.mode).toBe("form");
    expect(elicitationParams.message).toBe("Browser tool ที่ใช้ capture ไม่มีใน session นี้ — จะให้ผมเดินหน้าทางไหน?");
    expect(elicitationParams.requestedSchema.type).toBe("object");
    expect(elicitationParams.requestedSchema.required).toEqual(["q0"]);
    expect(elicitationParams.requestedSchema.properties.q0.type).toBe("string");
    expect(elicitationParams.requestedSchema.properties.q0.title).toBe("Unblock");
    expect(elicitationParams.requestedSchema.properties.q0.description).toBe(
      "Browser tool ที่ใช้ capture ไม่มีใน session นี้ — จะให้ผมเดินหน้าทางไหน?"
    );
    expect(elicitationParams.requestedSchema.properties.q0.oneOf).toHaveLength(2);

    // Verify resolveInteraction was called on serve
    expect(resolvedInteractionId).toBe("interact_ask_999");
    expect(resolvedAnswer).toEqual({
      action: "accept",
      content: {
        q0: "เปิด MCP browser-use ให้ผม (Recommended)",
      },
      optionId: "เปิด MCP browser-use ให้ผม (Recommended)",
    });
  });

  it("handles cancelled or declined elicitation gracefully", async () => {
    const server = new AcpServer(() => {});

    server.clientRequest = async () => {
      return { action: "cancel" };
    };

    let resolvedAnswer: unknown;
    const mockBridge = {
      serve: {
        resolveInteraction: async (_id: string, ans: unknown) => {
          resolvedAnswer = ans;
          return { status: "accepted" };
        },
      },
      translator: {
        getLatestActiveToolCallId: () => undefined,
      },
      handledInteractions: new Set<string>(),
    };

    (server as unknown as { sessions: Map<string, unknown> }).sessions.set("sess_456", mockBridge);

    await (server as unknown as {
      handlePendingInteraction: (sessionId: string, interaction: unknown) => Promise<void>;
    }).handlePendingInteraction("sess_456", {
      interactionId: "interact_cancel_1",
      kind: "userInput",
      payload: {
        prompt: "Choose option",
        options: [{ optionId: "opt1", label: "Option 1" }],
      },
    });

    expect(resolvedAnswer).toEqual({
      action: "cancel",
      optionId: "deny",
    });
  });
});

import { describe, expect, it } from "bun:test";
import { FrameTranslator } from "../src/translate.ts";

describe("FrameTranslator", () => {
  it("translates streaming assistant text and settlement", () => {
    const translator = new FrameTranslator(() => {});
    
    // Chunk 1
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: { rowId: 1, kind: "assistantText", text: "Hello", state: "streaming" },
          },
        ],
      },
    });
    expect(res1.updates).toHaveLength(1);
    expect(res1.updates[0]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    expect(res1.assistantSettled).toBe(false);
    expect(res1.turnComplete).toBe(false);

    // Chunk 2 (accumulated)
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: { rowId: 1, kind: "assistantText", text: "Hello world!", state: "complete" },
          },
        ],
      },
    });
    expect(res2.updates).toHaveLength(1);
    expect(res2.updates[0]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world!" },
    });
    expect(res2.assistantSettled).toBe(true);
  });

  it("handles row.delta op for streaming append", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.delta",
            rowId: 1,
            append: "Chunk text",
          },
        ],
      },
    });
    expect(res.updates).toHaveLength(1);
    expect(res.updates[0]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Chunk text" },
    });
  });

  it("handles row.delta op for reasoning streaming as agent_thought_chunk", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: { rowId: 2, kind: "reasoning", state: "streaming" },
          },
          {
            op: "row.delta",
            rowId: 2,
            append: "Thinking through the problem...",
          },
        ],
      },
    });
    expect(res.updates).toHaveLength(1);
    expect(res.updates[0]).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking through the problem..." },
    });
  });

  it("detects completedSuccess in turnHeader", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: { rowId: 0, kind: "turnHeader", state: "completedSuccess" },
          },
        ],
      },
    });
    expect(res.turnComplete).toBe(true);
    expect(res.turnFailed).toBe(false);
    expect(res.hasActiveWork).toBe(false);
  });

  it("detects running in turnHeader and marks hasActiveWork true", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: { rowId: 0, kind: "turnHeader", state: "running" },
          },
        ],
      },
    });
    expect(res.turnComplete).toBe(false);
    expect(res.hasActiveWork).toBe(true);
  });

  it("translates subagent rows and tracks active status", () => {
    const translator = new FrameTranslator(() => {});

    // Subagent spawned
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 10,
              kind: "subagent",
              subagentType: "general-purpose",
              status: "running",
              summaryText: "Investigating repo dependencies",
            },
          },
        ],
      },
    });

    expect(res1.updates).toHaveLength(1);
    expect(res1.updates[0].sessionUpdate).toBe("tool_call");
    expect(res1.updates[0].title).toBe("Subagent: general-purpose");
    expect(res1.updates[0].content).toEqual([{ type: "content", content: { type: "text", text: "Investigating repo dependencies" } }]);
    expect(res1.hasActiveWork).toBe(true);

    // Subagent progress update
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 10,
              kind: "subagent",
              subagentType: "general-purpose",
              status: "running",
              summaryText: "Found node_modules in main checkout",
            },
          },
        ],
      },
    });
    expect(res2.updates).toHaveLength(1);
    expect(res2.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res2.updates[0].status).toBe("in_progress");
    expect(res2.updates[0].content).toEqual([{ type: "content", content: { type: "text", text: "Found node_modules in main checkout" } }]);
    expect(res2.hasActiveWork).toBe(true);

    // Subagent completed
    const res3 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 10,
              kind: "subagent",
              subagentType: "general-purpose",
              status: "success",
              summaryText: "Dependencies verified",
            },
          },
        ],
      },
    });
    expect(res3.updates).toHaveLength(1);
    expect(res3.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res3.updates[0].status).toBe("completed");
    expect(res3.hasActiveWork).toBe(false);
  });

  it("translates Bash toolCall with command, rawInput, and output content", () => {
    const translator = new FrameTranslator(() => {});
    translator.startTurn();

    // 1. Tool call streaming in
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 4,
              kind: "toolCall",
              toolCallId: "call_abc123",
              toolName: "Bash",
              status: "inputStreaming",
              inputText: "{\"command\":\"git log --oneline -15\"}",
              input: { command: "git log --oneline -15" },
            },
          },
        ],
      },
    });

    expect(res1.updates).toHaveLength(1);
    expect(res1.updates[0].sessionUpdate).toBe("tool_call");
    expect(res1.updates[0].toolCallId).toBe("call_abc123");
    expect(res1.updates[0].name).toBe("Bash");
    expect(res1.updates[0].kind).toBe("execute");
    expect(res1.updates[0].title).toBe("git log --oneline -15");
    expect(res1.updates[0].status).toBe("pending");
    expect(res1.updates[0].rawInput).toEqual({ command: "git log --oneline -15" });
    expect(res1.hasActiveWork).toBe(true);

    // 2. Tool call running
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 4,
              kind: "toolCall",
              toolCallId: "call_abc123",
              toolName: "Bash",
              status: "running",
              input: { command: "git log --oneline -15" },
            },
          },
        ],
      },
    });

    expect(res2.updates).toHaveLength(1);
    expect(res2.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res2.updates[0].status).toBe("in_progress");
    expect(res2.hasActiveWork).toBe(true);

    // 3. Tool call completed with output
    const res3 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 4,
              kind: "toolCall",
              toolCallId: "call_abc123",
              toolName: "Bash",
              status: "success",
              input: { command: "git log --oneline -15" },
              output: { text: "ee3706a feat(content-sync)\n1234567 fix" },
            },
          },
        ],
      },
    });

    expect(res3.updates).toHaveLength(1);
    expect(res3.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res3.updates[0].status).toBe("completed");
    expect(res3.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "ee3706a feat(content-sync)\n1234567 fix" } },
    ]);
  });

  it("handles backgrounded toolCall and subagent metadata", () => {
    const translator = new FrameTranslator(() => {});

    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 8,
              kind: "toolCall",
              toolCallId: "call_bg1",
              toolName: "Bash",
              status: "running",
              input: { command: "npm run build" },
              backgrounded: true,
              workId: "work_999",
            },
          },
        ],
      },
    });

    expect(res.updates[0].title).toBe("[Background] npm run build");
    expect(res.updates[0]._meta).toEqual({ backgrounded: true, workId: "work_999" });
    expect(res.hasActiveWork).toBe(true);
  });

  it("detects failed state in turnHeader and marks turnFailed with error", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 0,
              kind: "turnHeader",
              state: "failed",
              error: { message: "Model request auth is unavailable: account:zai-offpeak-idle-plan" },
            },
          },
        ],
      },
    });
    expect(res.turnComplete).toBe(true);
    expect(res.turnFailed).toBe(true);
    expect(res.errorMessage).toBe("Model request auth is unavailable: account:zai-offpeak-idle-plan");
  });

  it("detects state.updated patch.control.lastError and marks turnFailed", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              control: {
                lastError: {
                  code: "model_request_auth_missing",
                  message: "Auth missing for model",
                },
              },
            },
          },
        ],
      },
    });
    expect(res.turnComplete).toBe(true);
    expect(res.turnFailed).toBe(true);
    expect(res.errorMessage).toBe("Auth missing for model");
  });

  it("handles row.delta op for streaming tool output (path: output.text)", () => {
    const translator = new FrameTranslator(() => {});
    translator.startTurn();

    // Setup tool call row
    translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 10,
              kind: "toolCall",
              toolCallId: "call_stream_1",
              toolName: "Bash",
              status: "in_progress",
              input: { command: "npm test" },
            },
          },
        ],
      },
    });

    // Stream chunk 1
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.delta",
            rowId: 10,
            path: "output.text",
            append: "PASS test/a.test.ts\n",
          },
        ],
      },
    });

    expect(res1.updates).toHaveLength(1);
    expect(res1.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res1.updates[0].toolCallId).toBe("call_stream_1");
    expect(res1.updates[0].status).toBe("in_progress");
    expect(res1.updates[0].rawOutput).toEqual({ text: "PASS test/a.test.ts\n" });
    expect(res1.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "PASS test/a.test.ts\n" } },
    ]);

    // Stream chunk 2
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.delta",
            rowId: 10,
            path: "output.text",
            append: "PASS test/b.test.ts\n",
          },
        ],
      },
    });

    expect(res2.updates).toHaveLength(1);
    expect(res2.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res2.updates[0].toolCallId).toBe("call_stream_1");
    expect(res2.updates[0].rawOutput).toEqual({ text: "PASS test/a.test.ts\nPASS test/b.test.ts\n" });
    expect(res2.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "PASS test/a.test.ts\nPASS test/b.test.ts\n" } },
    ]);

    // Tool finishes: upserted row picks up accumulated streamedOutput if output.text is absent
    const res3 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 10,
              kind: "toolCall",
              toolCallId: "call_stream_1",
              toolName: "Bash",
              status: "success",
            },
          },
        ],
      },
    });

    expect(res3.updates).toHaveLength(1);
    expect(res3.updates[0].sessionUpdate).toBe("tool_call_update");
    expect(res3.updates[0].status).toBe("completed");
    expect(res3.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "PASS test/a.test.ts\nPASS test/b.test.ts\n" } },
    ]);
  });

  it("handles control.phase transitions in state.updated patch", () => {
    const translator = new FrameTranslator(() => {});
    translator.startTurn();

    // 1. Running phase keeps hasActiveWork true
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              control: { phase: "running", activeWorks: [] },
            },
          },
        ],
      },
    });
    expect(res1.turnComplete).toBe(false);
    expect(res1.hasActiveWork).toBe(true);

    // 2. CompletedSuccess marks turnComplete true and clears hasActiveWork
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              control: { phase: "completedSuccess", activeWorks: [] },
            },
          },
        ],
      },
    });
    expect(res2.turnComplete).toBe(true);
    expect(res2.turnFailed).toBe(false);
    expect(res2.hasActiveWork).toBe(false);

    // 3. getLatestActiveToolCallId returns tool id
    translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 5,
              kind: "toolCall",
              toolCallId: "tool_latest_id",
              toolName: "Bash",
              status: "in_progress",
            },
          },
        ],
      },
    });
    expect(translator.getLatestActiveToolCallId()).toBe("tool_latest_id");
  });

  it("handles pendingInteractions in patch and toolCall approvalInteractionId", () => {
    const translator = new FrameTranslator(() => {});
    translator.startTurn();

    // 1. Tool call with approvalInteractionId
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 12,
              kind: "toolCall",
              toolCallId: "call_bash_gh_123",
              toolName: "Bash",
              status: "pendingApproval",
              approvalInteractionId: "interact_req_456",
              title: "gh pr view 14",
            },
          },
        ],
      },
    });

    expect(res1.hasActiveWork).toBe(true);
    expect(res1.pendingInteractions).toBeDefined();
    expect(res1.pendingInteractions).toHaveLength(1);
    expect(res1.pendingInteractions![0].interactionId).toBe("interact_req_456");
    expect(res1.pendingInteractions![0].payload?.toolCallId).toBe("call_bash_gh_123");

    // 2. state.updated patch with pendingInteractions
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              pendingInteractions: [
                {
                  interactionId: "interact_req_789",
                  kind: "permission",
                  payload: {
                    toolName: "Bash",
                    toolCallId: "call_bash_git_999",
                    summary: "Run git status",
                    options: [
                      { optionId: "allow", label: "Allow", kind: "allowOnce" },
                      { optionId: "deny", label: "Deny", kind: "deny" },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(res2.hasActiveWork).toBe(true);
    expect(res2.pendingInteractions).toBeDefined();
    expect(res2.pendingInteractions![0].interactionId).toBe("interact_req_789");
    expect(res2.pendingInteractions![0].payload?.options).toHaveLength(2);
  });

  it("handles AskUserQuestion toolCall as userInput with extracted questions", () => {
    const translator = new FrameTranslator(() => {});
    translator.startTurn();

    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 20,
              kind: "toolCall",
              toolCallId: "call_ask_user_1",
              toolName: "AskUserQuestion",
              status: "pendingApproval",
              approvalInteractionId: "interact_ask_1",
              title: "Ask question",
              input: {
                questions: [
                  {
                    header: "Unblock",
                    question: "Choose a path forward:",
                    multiSelect: false,
                    options: [
                      { label: "Option A", value: "opt_a", description: "First choice" },
                      { label: "Option B", value: "opt_b", description: "Second choice" },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    });

    expect(res.hasActiveWork).toBe(true);
    expect(res.pendingInteractions).toBeDefined();
    expect(res.pendingInteractions).toHaveLength(1);
    const item = res.pendingInteractions![0];
    expect(item.interactionId).toBe("interact_ask_1");
    expect(item.kind).toBe("userInput");
    expect(item.payload?.toolName).toBe("AskUserQuestion");
    expect(item.payload?.questions).toHaveLength(1);
    expect(item.payload?.questions![0].header).toBe("Unblock");
    expect(item.payload?.questions![0].options).toHaveLength(2);
  });
});


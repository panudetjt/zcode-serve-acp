import { describe, expect, it } from "bun:test";
import { FrameTranslator, classifyRowKind } from "../src/translate/translator.ts";

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
    expect(res1.updates[0]!).toEqual({
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
    expect(res2.updates[0]!).toEqual({
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
    expect(res.updates[0]!).toEqual({
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
    expect(res.updates[0]!).toEqual({
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
    expect(res1.updates[0]!.sessionUpdate).toBe("tool_call");
    expect(res1.updates[0]!.title).toBe("Subagent: general-purpose");
    expect(res1.updates[0]!.content).toEqual([
      { type: "content", content: { type: "text", text: "Investigating repo dependencies" } },
    ]);
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
    expect(res2.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res2.updates[0]!.status).toBe("in_progress");
    expect(res2.updates[0]!.content).toEqual([
      { type: "content", content: { type: "text", text: "Found node_modules in main checkout" } },
    ]);
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
    expect(res3.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res3.updates[0]!.status).toBe("completed");
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
              inputText: '{"command":"git log --oneline -15"}',
              input: { command: "git log --oneline -15" },
            },
          },
        ],
      },
    });

    expect(res1.updates).toHaveLength(1);
    expect(res1.updates[0]!.sessionUpdate).toBe("tool_call");
    expect(res1.updates[0]!.toolCallId).toBe("call_abc123");
    expect(res1.updates[0]!.name).toBe("Bash");
    expect(res1.updates[0]!.kind).toBe("execute");
    expect(res1.updates[0]!.title).toBe("git log --oneline -15");
    expect(res1.updates[0]!.status).toBe("pending");
    expect(res1.updates[0]!.rawInput).toEqual({ command: "git log --oneline -15" });
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
    expect(res2.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res2.updates[0]!.status).toBe("in_progress");
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
    expect(res3.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res3.updates[0]!.status).toBe("completed");
    expect(res3.updates[0]!.content).toEqual([
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

    expect(res.updates[0]!.title).toBe("[Background] npm run build");
    expect(res.updates[0]!._meta).toEqual({ backgrounded: true, workId: "work_999" });
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
    expect(res1.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res1.updates[0]!.toolCallId).toBe("call_stream_1");
    expect(res1.updates[0]!.status).toBe("in_progress");
    expect(res1.updates[0]!.rawOutput).toEqual({ text: "PASS test/a.test.ts\n" });
    expect(res1.updates[0]!.content).toEqual([
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
    expect(res2.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res2.updates[0]!.toolCallId).toBe("call_stream_1");
    expect(res2.updates[0]!.rawOutput).toEqual({ text: "PASS test/a.test.ts\nPASS test/b.test.ts\n" });
    expect(res2.updates[0]!.content).toEqual([
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
    expect(res3.updates[0]!.sessionUpdate).toBe("tool_call_update");
    expect(res3.updates[0]!.status).toBe("completed");
    expect(res3.updates[0]!.content).toEqual([
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
    expect(res1.pendingInteractions![0]!.interactionId).toBe("interact_req_456");
    expect(res1.pendingInteractions![0]!.payload?.toolCallId).toBe("call_bash_gh_123");

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
    expect(res2.pendingInteractions![0]!.interactionId).toBe("interact_req_789");
    expect(res2.pendingInteractions![0]!.payload?.options).toHaveLength(2);
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
    const item = res.pendingInteractions![0]!;
    expect(item.interactionId).toBe("interact_ask_1");
    expect(item!.kind).toBe("userInput");
    expect(item!.payload?.toolName).toBe("AskUserQuestion");
    expect(item!.payload?.questions).toHaveLength(1);
    expect(item!.payload?.questions![0]!.header).toBe("Unblock");
    expect(item!.payload?.questions![0]!.options).toHaveLength(2);
  });

  it("classifyRowKind delegates to classifyToolKind", () => {
    expect(classifyRowKind("bash")).toBe("execute");
    expect(classifyRowKind("read_file")).toBe("read");
  });

  it("handles rawError in payload envelope with string, message, raw json, and circular", () => {
    const translator = new FrameTranslator(() => {});
    const r1 = translator.fold({ payload: { error: "Daemon disconnected" } });
    expect(r1.turnComplete).toBe(true);
    expect(r1.turnFailed).toBe(true);
    expect(r1.errorMessage).toBe("Daemon disconnected");

    const r2 = translator.fold({ payload: { error: { message: "Internal crash" } } });
    expect(r2.errorMessage).toBe("Internal crash");

    const r3 = translator.fold({ payload: { error: { code: 500 } } });
    expect(r3.errorMessage).toBe('{"code":500}');

    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    const r4 = translator.fold({ payload: { error: circ } });
    expect(r4.errorMessage).toBe("unknown daemon error");
  });

  it("reads snapshot pending interactions from envelope", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        snapshot: {
          pendingInteractions: [{ interactionId: "snap_1", kind: "permission", payload: { toolName: "read" } }],
        },
      },
    });
    expect(res.pendingInteractions).toBeDefined();
    expect(res.pendingInteractions).toHaveLength(1);
    expect(res.pendingInteractions![0]!.interactionId).toBe("snap_1");
  });

  it("handles turnPhase completedInterrupted and error in control patch", () => {
    const translator = new FrameTranslator(() => {});
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: { control: { phase: "completedInterrupted" } },
          },
        ],
      },
    });
    expect(res1.turnComplete).toBe(true);
    expect(res1.turnCancelled).toBe(true);

    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: { control: { phase: "error", lastError: { message: "Control error" } } },
          },
        ],
      },
    });
    expect(res2.turnComplete).toBe(true);
    expect(res2.turnFailed).toBe(true);
    expect(res2.errorMessage).toBe("Control error");
  });

  it("handles unknown ops and turnHeader cancelled/interrupted state", () => {
    const translator = new FrameTranslator(() => {});
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [{ op: "custom.op.ignore" }],
      },
    });
    expect(res1.updates).toHaveLength(0);

    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: { rowId: 10, kind: "turnHeader", state: "cancelled" },
          },
        ],
      },
    });
    expect(res2.turnComplete).toBe(true);
    expect(res2.turnCancelled).toBe(true);
  });

  it("translates usage row with contextUsed, contextWindow, and token breakdown", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 11,
              kind: "usage",
              contextUsed: 12000,
              contextWindow: 128000,
              totalTokens: 1500,
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 300,
              cacheWriteTokens: 100,
            },
          },
        ],
      },
    });
    expect(res.updates).toHaveLength(1);
    expect(res.updates[0]!).toEqual({
      sessionUpdate: "usage_update",
      used: 12000,
      size: 128000,
    });
    expect(res.usage).toEqual({
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      cachedReadTokens: 300,
      cachedWriteTokens: 100,
    });
  });

  it("handles assistant failure state and explicit error row", () => {
    const translator = new FrameTranslator(() => {});
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 12,
              kind: "assistantText",
              text: "Generating...",
              state: "failed",
              error: { message: "Model timeout" },
            },
          },
        ],
      },
    });
    expect(res1.turnComplete).toBe(true);
    expect(res1.turnFailed).toBe(true);
    expect(res1.errorMessage).toBe("Model timeout");

    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: { rowId: 13, kind: "error", error: { message: "Fatal crash" } },
          },
        ],
      },
    });
    expect(res2.turnComplete).toBe(true);
    expect(res2.turnFailed).toBe(true);
    expect(res2.errorMessage).toBe("Fatal crash");
  });

  it("translates subagent rows lifecycle, backgrounded meta, and tool updates", () => {
    const translator = new FrameTranslator(() => {});
    // Subagent started
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 30,
              kind: "subagent",
              status: "in_progress",
              subagentType: "research",
              summaryText: "Researching codebase",
              backgrounded: true,
              workId: "work_sub_1",
            },
          },
        ],
      },
    });
    expect(res1.hasActiveWork).toBe(true);
    expect(res1.updates).toHaveLength(1);
    expect(res1.updates[0]!).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "sub_work_sub_1",
      title: "Subagent: research",
      name: "subagent",
      kind: "other",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "Researching codebase" } }],
      _meta: { backgrounded: true, workId: "work_sub_1" },
    });

    // Subagent completed update
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.updated",
            row: {
              rowId: 30,
              kind: "subagent",
              status: "completed",
              subagentType: "research",
              summaryText: "Found answer",
              backgrounded: true,
              workId: "work_sub_1",
            },
          },
        ],
      },
    });
    expect(res2.hasActiveWork).toBe(false);
    expect(res2.updates).toHaveLength(1);
    expect(res2.updates[0]!).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "sub_work_sub_1",
      title: "Subagent: research",
      name: "subagent",
      kind: "other",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Found answer" } }],
      _meta: { backgrounded: true, workId: "work_sub_1" },
    });
  });

  it("handles toolCall input fallbacks: non-JSON inputText, cmd, file, filePath, description, error output", () => {
    const translator = new FrameTranslator(() => {});

    // 1. Execute tool with raw string inputText (JSON parse fails -> fallback to command)
    const res1 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 40,
              kind: "toolCall",
              toolName: "bash",
              inputText: "ls -la /tmp",
              status: "in_progress",
            },
          },
        ],
      },
    });
    expect(res1.updates).toHaveLength(1);
    const tc1 = res1.updates[0]!;
    expect(tc1.sessionUpdate).toBe("tool_call");
    if (tc1.sessionUpdate === "tool_call") {
      expect(tc1.title).toBe("ls -la /tmp");
      expect(tc1.rawInput).toEqual({ command: "ls -la /tmp" });
    }

    // 2. Tool with cmd, filePath, file, description, backgrounded
    const res2 = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 41,
              kind: "toolCall",
              name: "custom_cmd",
              input: { cmd: "curl http://localhost" },
              backgrounded: true,
              workId: "work_bg_cmd",
              status: "in_progress",
            },
          },
          {
            op: "row.appended",
            row: {
              rowId: 42,
              kind: "toolCall",
              toolName: "edit",
              input: { filePath: "/src/index.ts" },
              status: "in_progress",
            },
          },
          {
            op: "row.appended",
            row: {
              rowId: 43,
              kind: "toolCall",
              toolName: "reader",
              input: { file: "/docs/readme.md" },
              status: "in_progress",
            },
          },
          {
            op: "row.appended",
            row: {
              rowId: 44,
              kind: "toolCall",
              toolName: "misc",
              input: { description: "Inspect database records" },
              status: "failed",
              error: { message: "Database connection failed" },
            },
          },
        ],
      },
    });
    expect(res2.updates).toHaveLength(4);
    const [u41, u42, u43, u44] = res2.updates;
    if (u41?.sessionUpdate === "tool_call") {
      expect(u41.title).toBe("[Background] curl http://localhost");
      expect(u41._meta).toEqual({ backgrounded: true, workId: "work_bg_cmd" });
    }
    if (u42?.sessionUpdate === "tool_call") {
      expect(u42.title).toBe("edit: /src/index.ts");
      expect(u42.locations).toEqual([{ path: "/src/index.ts" }]);
    }
    if (u43?.sessionUpdate === "tool_call") {
      expect(u43.title).toBe("reader: /docs/readme.md");
      expect(u43.locations).toEqual([{ path: "/docs/readme.md" }]);
    }
    if (u44?.sessionUpdate === "tool_call") {
      expect(u44.title).toBe("Inspect database records");
      expect(u44.content).toEqual([{ type: "content", content: { type: "text", text: "Database connection failed" } }]);
    }
  });

  it("merges existing pendingInteractions with matching approvalInteractionId", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        snapshot: {
          pendingInteractions: [
            {
              interactionId: "interact_existing_1",
              kind: "userInput",
              payload: { toolName: "AskUserQuestion", summary: "Initial question" },
            },
          ],
        },
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 50,
              kind: "toolCall",
              toolName: "AskUserQuestion",
              approvalInteractionId: "interact_existing_1",
              input: {
                questions: [{ question: "Do you confirm?", options: [{ label: "Yes", value: "y" }] }],
              },
            },
          },
        ],
      },
    });
    expect(res.pendingInteractions).toBeDefined();
    expect(res.pendingInteractions).toHaveLength(1);
    const merged = res.pendingInteractions![0]!;
    expect(merged.interactionId).toBe("interact_existing_1");
    expect(merged.payload?.questions).toHaveLength(1);
    expect(merged.payload?.summary).toBe("Initial question");
  });

  it("records unknown row kind in unknownKinds map", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: { rowId: 999, kind: "unregisteredSpecialRow", text: "anything" },
          },
        ],
      },
    });
    expect(res.updates).toHaveLength(0);
  });
});

describe("FrameTranslator uncovered-edge coverage", () => {
  it("phase=error without lastError falls back to the default failure message", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [{ op: "state.updated", patch: { control: { phase: "error" } } }],
      },
    });
    expect(res.turnFailed).toBe(true);
    expect(res.turnComplete).toBe(true);
    expect(res.errorMessage).toBe("Turn execution failed in daemon");
  });

  it("subagent row without summaryText produces a tool call without content", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: { rowId: 21, kind: "subagent", subagentType: "researcher", status: "completed" },
          },
        ],
      },
    });
    const tool = res.updates.find((u) => u.sessionUpdate === "tool_call") as
      | { title?: string; content?: unknown }
      | undefined;
    expect(tool).toBeDefined();
    expect(tool?.content).toBeUndefined();
    expect(tool?.title).toBe("Subagent: researcher");
  });

  it("merge keeps existing questions when the new input also carries questions", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              pendingInteractions: [
                {
                  interactionId: "appr-q",
                  kind: "userInput",
                  payload: {
                    toolName: "AskUserQuestion",
                    summary: "Original",
                    questions: [{ header: "H1", question: "Q1?", options: [] }],
                  },
                },
              ],
            },
          },
          {
            op: "row.upserted",
            row: {
              rowId: 31,
              kind: "toolCall",
              toolName: "AskUserQuestion",
              status: "pendingApproval",
              approvalInteractionId: "appr-q",
              input: { questions: [{ header: "H2", question: "Q2?", options: [] }] },
            },
          },
        ],
      },
    });
    expect(res.pendingInteractions).toHaveLength(1);
    const merged = res.pendingInteractions![0]!;
    expect(merged.payload?.questions?.[0]?.header).toBe("H1");
    expect(merged.payload?.summary).toBe("Original");
  });

  it("toolCall input with a path keys the title and locations off it", () => {
    const translator = new FrameTranslator(() => {});
    const res = translator.fold({
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "row.upserted",
            row: {
              rowId: 41,
              kind: "toolCall",
              toolName: "read",
              status: "completed",
              input: { path: "/tmp/f.txt" },
            },
          },
        ],
      },
    });
    const tool = res.updates.find((u) => u.sessionUpdate === "tool_call") as
      | { title?: string; locations?: Array<{ path: string }> }
      | undefined;
    expect(tool?.title).toBe("read: /tmp/f.txt");
    expect(tool?.locations).toEqual([{ path: "/tmp/f.txt" }]);
  });

  it("debug flag logs unknown row kinds when constructed with ZCODE_SERVE_ACP_DEBUG=1", () => {
    const original = process.env.ZCODE_SERVE_ACP_DEBUG;
    process.env.ZCODE_SERVE_ACP_DEBUG = "1";
    try {
      const lines: unknown[][] = [];
      const translator = new FrameTranslator((...parts: unknown[]) => {
        lines.push(parts);
      });
      translator.fold({
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.appended", row: { rowId: 55, kind: "mysteryWidget", text: "x" } }],
        },
      });
      expect(lines.some((parts) => parts.some((p) => String(p).includes("unknown row kind=mysteryWidget")))).toBe(true);
    } finally {
      if (original !== undefined) process.env.ZCODE_SERVE_ACP_DEBUG = original;
      else delete process.env.ZCODE_SERVE_ACP_DEBUG;
    }
  });
});

/**
 * Interaction logic tests — target the pure functions in acp/interactions.ts
 * (the pre-rewrite suite drove private methods through `as unknown as`
 * casts; this is the public-API replacement).
 */
import { describe, expect, it } from "bun:test"
import {
  buildElicitationParams,
  buildElicitationResolve,
  buildPermissionParams,
  DEFAULT_ALLOW_OPTION_ID,
  extractElicitationQuestions,
  extractPermissionOptionId,
  isElicitation,
  mapPermissionOptions,
  readPermissionServerRequest,
  type ExtractedQuestion
} from "../src/acp/interactions.ts"
import type { PendingInteraction } from "../src/translate/translator.ts"

const interaction = (payload: Record<string, unknown>, kind = "userInput"): PendingInteraction => ({
  interactionId: "interact_ask_999",
  kind,
  payload: payload as PendingInteraction["payload"]
})

describe("isElicitation routing", () => {
  it("routes userInput kinds and AskUserQuestion/ExitPlanMode tools to elicitation", () => {
    expect(isElicitation(interaction({ kind: "userInput" }))).toBe(true)
    expect(isElicitation(interaction({ toolName: "AskUserQuestion" }, "permission"))).toBe(true)
    expect(isElicitation(interaction({ toolName: "ExitPlanMode" }, "permission"))).toBe(true)
    expect(isElicitation(interaction({ questions: [{ header: "q" }] }))).toBe(true)
  })

  it("routes plain permission payloads to request_permission", () => {
    expect(
      isElicitation(
        interaction({ toolName: "Bash", options: [{ optionId: "allow", kind: "allowOnce" }] }, "permission")
      )
    ).toBe(false)
  })
})

describe("elicitation/create translation", () => {
  it("builds the requestedSchema from questions and maps accept answers to resolveInteraction", () => {
    const payload = {
      kind: "userInput",
      prompt: "ทางแก้ที่เป็นไปได้ ขอให้คุณเลือกให้ทีครับ:",
      questions: [
        {
          header: "Unblock",
          question: "Browser tool ที่ใช้ capture ไม่มีใน session นี้ — จะให้ผมเดินหน้าทางไหม?",
          multiSelect: false,
          options: [
            {
              label: "เปิด MCP browser-use ให้ผม (Recommended)",
              value: "เปิด MCP browser-use ให้ผม (Recommended)",
              description: "เช็ค MCP server ของ ZCode"
            },
            {
              label: "อนุญาต shell ให้ใช้ browser client",
              value: "อนุญาต shell ให้ใช้ browser client",
              description: "ผมจะใช้ shell"
            }
          ]
        }
      ]
    }

    const questions = extractElicitationQuestions(interaction(payload))
    const params = buildElicitationParams("sess_123", questions, payload)

    expect(params.sessionId).toBe("sess_123")
    expect(params.mode).toBe("form")
    expect(params.message).toBe("Browser tool ที่ใช้ capture ไม่มีใน session นี้ — จะให้ผมเดินหน้าทางไหม?")
    expect(params.requestedSchema.type).toBe("object")
    expect(params.requestedSchema.required).toEqual(["q0"])
    const q0 = params.requestedSchema.properties.q0 as {
      type: string
      title: string
      description: string
      oneOf?: unknown[]
    }
    expect(q0.type).toBe("string")
    expect(q0.title).toBe("Unblock")
    expect(q0.description).toBe("Browser tool ที่ใช้ capture ไม่มีใน session นี้ — จะให้ผมเดินหน้าทางไหม?")
    expect(q0.oneOf).toHaveLength(2)

    const resolve = buildElicitationResolve(
      { action: "accept", content: { q0: "เปิด MCP browser-use ให้ผม (Recommended)" } },
      questions
    )
    expect(resolve).toEqual({
      action: "accept",
      content: { q0: "เปิด MCP browser-use ให้ผม (Recommended)" },
      optionId: "เปิด MCP browser-use ให้ผม (Recommended)"
    })
  })

  it("maps declined/cancelled answers to the deny payload", () => {
    const questions: ExtractedQuestion[] = extractElicitationQuestions(
      interaction({ prompt: "Choose option", options: [{ optionId: "opt1", label: "Option 1" }] })
    )
    const resolve = buildElicitationResolve({ action: "cancel" }, questions)
    expect(resolve).toEqual({ action: "cancel", optionId: "deny" })
    expect(buildElicitationResolve({ action: "decline" }, questions)).toEqual({ action: "decline", optionId: "deny" })
  })

  it("extracts ExitPlanMode into an approve/reject form", () => {
    const questions = extractElicitationQuestions(
      interaction({ kind: "userInput", toolName: "ExitPlanMode", input: { plan: "1. do it" } }, "permission")
    )
    expect(questions).toHaveLength(1)
    expect(questions[0]!.header).toBe("Plan")
    expect(questions[0]!.question).toContain("1. do it")
    expect(questions[0]!.options.map((o) => o.value)).toEqual(["approve", "reject"])

    const params = buildElicitationParams("s", questions, { toolName: "ExitPlanMode" })
    expect(params.requestedSchema.properties.q0).toMatchObject({ type: "string", title: "Plan" })
  })
})

describe("request_permission mapping", () => {
  it("classifies daemon option kinds into ACP kinds with last-is-deny fallback", () => {
    const mapped = mapPermissionOptions([
      { optionId: "a", label: "Allow", kind: "allowOnce" },
      { optionId: "b", label: "Always", kind: "alwaysAllow" },
      { optionId: "c", label: "Deny", kind: "deny" }
    ])
    expect(mapped).toEqual([
      { optionId: "a", name: "Allow", kind: "allow_once" },
      { optionId: "b", name: "Always", kind: "allow_always" },
      { optionId: "c", name: "Deny", kind: "reject_once" }
    ])
  })

  it("extracts the chosen option from selected outcomes", () => {
    const rawOptions = [
      { optionId: "allow", kind: "allowOnce" },
      { optionId: "deny", kind: "deny" }
    ]
    const mapped = mapPermissionOptions(rawOptions)
    expect(extractPermissionOptionId({ outcome: { outcome: "selected", optionId: "deny" } }, rawOptions, mapped)).toBe(
      "deny"
    )
    expect(extractPermissionOptionId({ outcome: { outcome: "cancelled" } }, rawOptions, mapped)).toBe("deny")
    expect(extractPermissionOptionId({ optionId: "allow" }, rawOptions, mapped)).toBe("allow")

    // When rawOptions has allow_once instead of allow, normalize allow -> allow_once
    const rawDaemonOptions = [
      { optionId: "allow_once", kind: "allowOnce" },
      { optionId: "deny", kind: "deny" }
    ]
    const mappedDaemon = mapPermissionOptions(rawDaemonOptions)
    expect(
      extractPermissionOptionId({ outcome: { outcome: "selected", optionId: "allow" } }, rawDaemonOptions, mappedDaemon)
    ).toBe("allow_once")
    expect(extractPermissionOptionId({ optionId: "allow" }, rawDaemonOptions, mappedDaemon)).toBe("allow_once")
  })

  it("falls back to the first mapped option when the client returns nothing usable", () => {
    const rawOptions = [{ optionId: "a", label: "Allow", kind: "allowOnce" }]
    const mapped = mapPermissionOptions(rawOptions)
    expect(extractPermissionOptionId({}, rawOptions, mapped)).toBe("a")
  })

  it("buildPermissionParams creates params with default or custom options", () => {
    const withDefaults = buildPermissionParams("sess-1", {}, "tool_123")
    expect(withDefaults.toolCall.toolCallId).toBe("tool_123")
    expect(withDefaults.options.length).toBe(2)
    expect(withDefaults.options[0]?.optionId).toBe("allow_once")
    expect(withDefaults.options[0]?.kind).toBe("allow_once")
    expect(withDefaults.options[1]?.optionId).toBe("deny")
    expect(withDefaults.options[1]?.kind).toBe("reject_once")

    const withCustom = buildPermissionParams(
      "sess-1",
      {
        toolCallId: "tool_custom",
        toolName: "Bash",
        summary: "Execute bash command",
        options: [{ optionId: "opt1", name: "Run once", kind: "allowOnce" }]
      },
      undefined
    )
    expect(withCustom.toolCall.toolCallId).toBe("tool_custom")
    expect(withCustom.toolCall.title).toBe("Execute bash command")
    expect(withCustom.options[0]?.optionId).toBe("opt1")
  })

  it("readPermissionServerRequest parses server requests safely", () => {
    const parsed = readPermissionServerRequest({
      interactionId: "act_1",
      toolCallId: "t_1",
      toolName: "Bash",
      options: [{ id: "opt1" }]
    })
    expect(parsed.interactionId).toBe("act_1")
    expect(parsed.toolCallId).toBe("t_1")
    expect(parsed.toolName).toBe("Bash")
    expect(parsed.options?.length).toBe(1)

    expect(readPermissionServerRequest(null)).toEqual({})
    expect(readPermissionServerRequest("not an object")).toEqual({})
  })

  it("extractElicitationQuestions fallbacks and multiselect schema", () => {
    const fallbackQ = extractElicitationQuestions({
      interactionId: "i1",
      kind: "userInput",
      payload: { prompt: "Please enter your name:" }
    })
    expect(fallbackQ.length).toBe(1)
    expect(fallbackQ[0]?.question).toBe("Please enter your name:")

    // multiSelect schema building
    const multiParams = buildElicitationParams(
      "sess-1",
      [
        {
          id: "choices",
          header: "Select items",
          question: "Choose items:",
          options: [{ label: "A", value: "a" }],
          multiSelect: true
        },
        {
          id: "notes",
          header: "Notes",
          question: "Extra notes",
          options: []
        }
      ],
      {}
    )
    expect((multiParams.requestedSchema.properties.choices as { type: string }).type).toBe("array")
    expect((multiParams.requestedSchema.properties.notes as { type: string }).type).toBe("string")

    // resolve text-only question
    const resolved = buildElicitationResolve({ action: "accept", content: { notes: "my note" } }, [
      { id: "notes", header: "Notes", question: "Extra notes", options: [] }
    ])
    expect(resolved.action).toBe("accept")
    expect(resolved.optionId).toBe("my note")

    // input.questions fallback
    const inputQ = extractElicitationQuestions({
      interactionId: "i2",
      kind: "userInput",
      payload: { input: { questions: [{ prompt: "From input?" }] } }
    })
    expect(inputQ.length).toBe(1)
    expect(inputQ[0]?.question).toBe("From input?")

    // reject_always mapping
    const mappedRejectAlways = mapPermissionOptions([{ optionId: "opt_block", kind: "rejectAlways" }])
    expect(mappedRejectAlways[0]?.kind).toBe("reject_always")

    // last option fallback to reject_once
    const mappedLastFallback = mapPermissionOptions([
      { optionId: "opt_1", kind: "allow" },
      { optionId: "opt_2", kind: "custom" }
    ])
    expect(mappedLastFallback[1]?.kind).toBe("reject_once")
  })
})

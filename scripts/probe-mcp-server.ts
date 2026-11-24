#!/usr/bin/env bun
/**
 * Minimal MCP server over stdio for scripts/probe-mcp-persist.ts: one tool,
 * no dependencies. The daemon's stdio transport speaks newline-delimited
 * JSON-RPC, so this is the whole protocol surface it needs.
 */
import { createInterface } from "node:readline"

const TOOL = {
  name: "probe_echo",
  description: "Echoes its text back. Exists only so a tool list is non-empty.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
}

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result })
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } })

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return
  let message: { id?: unknown; method?: string; params?: { protocolVersion?: string } }
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method } = message
  switch (method) {
    case "initialize":
      reply(id, {
        // Echo the client's version: negotiation succeeds without a fallback table.
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "probe-mcp", version: "0.0.0" }
      })
      return
    case "ping":
      reply(id, {})
      return
    case "tools/list":
      reply(id, { tools: [TOOL] })
      return
    case "tools/call": {
      const text = (message.params as { arguments?: { text?: unknown } } | undefined)?.arguments?.text
      reply(id, { content: [{ type: "text", text: String(text) }] })
      return
    }
    default:
      // Notifications ("notifications/initialized", …) carry no id and get no reply.
      if (id !== undefined) fail(id, -32601, `method not found: ${method}`)
  }
})

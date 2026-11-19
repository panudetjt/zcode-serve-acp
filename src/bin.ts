#!/usr/bin/env bun
/**
 * zcode-serve-acp — ACP over stdio. Attach a coding-agent client (t3code
 * Local ACP command) to the `zcode serve` daemon. The daemon owns ZCode
 * credentials; this process never reads them.
 *
 * Wire: newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only
 * (ZCODE_SERVE_ACP_DEBUG=1 for verbose).
 */
import { createAcpServer, stdinLines } from "./acp/server.ts";

const writeLine = (obj: unknown) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const server = createAcpServer((method, params) => writeLine({ jsonrpc: "2.0", method, params }));

// client→server requests WE send (permission asks): id ↔ promise map
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer }>();
let nextRequestId = 900_000;

server.clientRequest = (method: string, params: unknown) =>
  new Promise((resolve, reject) => {
    const id = nextRequestId++;
    writeLine({ jsonrpc: "2.0", id, method, params });
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`client request ${method} timed out (client never answered)`));
    }, 600_000);
    pending.set(id, { resolve, reject, timer });
  });

stdinLines(async (line) => {
  let msg: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message?: string };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    console.error("[bin] non-JSON line on stdin (ignored)");
    return;
  }

  // response to one of our client-side requests (permission asks)
  if (msg.id !== undefined && msg.method === undefined) {
    const numId = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const entry = pending.get(numId);
    if (entry !== undefined) {
      pending.delete(numId);
      clearTimeout(entry.timer);
      if (msg.error !== undefined) entry.reject(new Error(msg.error.message ?? "client returned error"));
      else entry.resolve(msg.result);
    }
    return;
  }

  if (msg.method === undefined) return;
  const isNotification = msg.id === undefined;
  try {
    const result = await server.handle(msg.method, msg.params ?? {}, async (m, p) => server.clientRequest(m, p));
    if (!isNotification) writeLine({ jsonrpc: "2.0", id: msg.id, result });
  } catch (error) {
    if (error instanceof Error && process.env.ZCODE_SERVE_ACP_DEBUG === "1") {
      console.error(`[bin] ${msg.method} threw:`, error.stack);
    }
    if (isNotification) {
      console.error(`[bin] notification ${msg.method} failed:`, error instanceof Error ? error.message : String(error));
      return;
    }
    writeLine({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
});

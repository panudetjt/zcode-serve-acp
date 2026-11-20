#!/usr/bin/env bun
/**
 * Extended probe: tool-call translation + session/load (resume) + a second
 * turn, against the live daemon.
 *
 * Usage: bun scripts/probe-tools-resume.mjs [--bin PATH] [--cwd PATH]
 *
 * Complements scripts/smoke.mjs (initialize → session/new → prompt):
 *   1. prompt that forces a shell tool call; assert tool_call and
 *      tool_call_update updates arrive
 *   2. session/load on the same session id; assert the id is preserved
 *   3. prompt again after resume; assert RESUME_OK is streamed
 *
 * `--bin` defaults to dist/zcode-serve-acp (falling back to src/bin.ts).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argOf = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
};

const binArg = argOf("--bin", "");
const binary = binArg !== "" ? path.resolve(binArg) : path.join(repo, "dist", "zcode-serve-acp");
if (binArg !== "" && !existsSync(binary)) {
  console.error(`[probe] --bin not found: ${binary}`);
  process.exit(2);
}
const useBinary = existsSync(binary);
const cmd = useBinary ? binary : "bun";
const args = useBinary ? [] : [path.join(repo, "src", "bin.ts")];
const cwd = argOf("--cwd", repo);

console.error(`[probe] bridge: ${[cmd, ...args].join(" ")}`);
const child = spawn(cmd, args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

let nextId = 1;
const pending = new Map();
let updates = [];
const seenMethods = new Set();

child.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      seenMethods.add(msg.method);
      const options = msg.params?.options ?? [];
      const allow = options.find((o) => String(o.kind ?? "").startsWith("allow")) ?? options[0];
      console.error(`[probe] server request ${msg.method} -> ${allow?.optionId}`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { optionId: allow?.optionId } }) + "\n");
      continue;
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
      continue;
    }
    if (msg.method === "session/update") updates.push(msg.params?.update);
  }
});
child.on("exit", (code) => {
  if (pending.size > 0) {
    console.error(`[probe] bridge exited early (code ${code})`);
    process.exit(1);
  }
});

function request(method, params, timeoutMs = 240_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) =>
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result),
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

const fail = (msg) => {
  console.error(`[probe] FAIL: ${msg}`);
  child.kill();
  process.exit(1);
};

const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
if (Number(init.protocolVersion) !== 1) fail(`protocolVersion ${init.protocolVersion}`);

const session = await request("session/new", { cwd, mcpServers: [] });
const models = session.models?.availableModels ?? [];
console.error(`[probe] session/new OK id=${session.sessionId} models=${models.length}`);

// Turn 1: force a shell tool call.
const first = await request("session/prompt", {
  sessionId: session.sessionId,
  prompt: [
    {
      type: "text",
      text: "Use the bash tool to run exactly: printf '%s' probe-ok-12345 . Then reply with the command output only.",
    },
  ],
});
const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call");
const toolUpdates = updates.filter((u) => u.sessionUpdate === "tool_call_update");
console.error(
  `[probe] turn1 stopReason=${first.stopReason} ` +
    `tool_call=${toolCalls.length} tool_call_update=${toolUpdates.length}`,
);
if (toolCalls.length === 0) fail("no tool_call update for a tool-using prompt");
if (toolUpdates.length === 0) fail("no tool_call_update (status progression)");

// Turn 2: resume the same session.
const loaded = await request("session/load", {
  sessionId: session.sessionId,
  cwd,
  mcpServers: [],
});
if (loaded.sessionId !== session.sessionId) {
  fail(`session/load returned ${loaded.sessionId}`);
}
console.error(`[probe] session/load OK meta=${JSON.stringify(loaded._meta)}`);

// Turn 3: prompt after resume.
updates = [];
const third = await request("session/prompt", {
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: RESUME_OK" }],
});
const text = updates
  .filter((u) => u.sessionUpdate === "agent_message_chunk")
  .map((u) => u.content?.text ?? "")
  .join("");
console.error(`[probe] turn3 stopReason=${third.stopReason} text=${JSON.stringify(text.slice(-120))}`);
if (!/RESUME_OK/.test(text)) fail("no RESUME_OK after resume");
if (seenMethods.size > 0) {
  console.error(`[probe] client-facing server requests: ${[...seenMethods].join(",")}`);
}
console.error("[probe] PASS");
child.kill();
process.exit(0);

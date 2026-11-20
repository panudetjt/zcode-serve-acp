#!/usr/bin/env bun
/**
 * Extended probe against the live daemon:
 *   1. session/new + a tool-using prompt (tool_call translation)
 *   2. session/load on the same bridge (T3 replay fast path) + prompt
 *   3. session/load from a fresh bridge process with the same ACP session id,
 *      then prompt — proves the id survives a bridge restart. The daemon
 *      conversation itself is NOT replayed by the bridge (Phase 2); the fresh
 *      load creates a new daemon session and returns replay_idle.
 *
 * Usage: bun scripts/probe-tools-load.mjs [--bin PATH] [--cwd PATH]
 *
 * `--bin` defaults to dist/zcode-serve-acp (falling back to src/bin.ts, which
 * the output names explicitly).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

function daemonVersion() {
  const home = process.env.HOME ?? homedir();
  const dataRoot = process.env.ZCODE_DATA_BASE_DIR ?? home;
  const serverRoot = process.env.ZCODE_SERVER_ROOT ?? path.join(dataRoot, ".zcode", "server");
  try {
    const status = JSON.parse(readFileSync(path.join(serverRoot, "run", "status.json"), "utf8"));
    return String(status.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

const clients = [];
const fail = (msg) => {
  console.error(`[probe] FAIL: ${msg}`);
  for (const client of clients) client.close();
  process.exit(1);
};

/**
 * Spawn one bridge and return a small ACP client over stdio.
 * `takeUpdates()` returns the updates seen since the previous call.
 */
function connect(label) {
  console.error(`[probe] ${label} bridge: ${[cmd, ...args].join(" ")}`);
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
    if (pending.size > 0) fail(`bridge exited early (code ${code})`);
  });

  const client = {
    child,
    seenMethods,
    request(method, params, timeoutMs = 240_000) {
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
    },
    takeUpdates() {
      const taken = updates;
      updates = [];
      return taken;
    },
    close() {
      child.kill();
    },
  };
  clients.push(client);
  return client;
}

function waitExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function textOf(updates) {
  return updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text ?? "")
    .join("");
}

const sessionPrompt = (sessionId, text) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

console.error(`[probe] daemon: ${daemonVersion()}`);

// --- Bridge A: new session, tool call, same-process load -------------------
const first = connect("session");
const init = await first.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
if (Number(init.protocolVersion) !== 1) fail(`protocolVersion ${init.protocolVersion}`);

const session = await first.request("session/new", { cwd, mcpServers: [] });
const models = session.models?.availableModels ?? [];
console.error(`[probe] session/new OK id=${session.sessionId} models=${models.length}`);

first.takeUpdates();
const toolTurn = await first.request(
  "session/prompt",
  sessionPrompt(
    session.sessionId,
    "Use the bash tool to run exactly: printf '%s' probe-ok-12345 . Then reply with the command output only.",
  ),
);
const toolUpdates = first.takeUpdates();
const toolCalls = toolUpdates.filter((u) => u.sessionUpdate === "tool_call");
const toolProgress = toolUpdates.filter((u) => u.sessionUpdate === "tool_call_update");
console.error(
  `[probe] tool turn stopReason=${toolTurn.stopReason} tool_call=${toolCalls.length} tool_call_update=${toolProgress.length}`,
);
if (toolCalls.length === 0) fail("no tool_call update for a tool-using prompt");
if (toolProgress.length === 0) fail("no tool_call_update (status progression)");

const sameLoad = await first.request("session/load", { sessionId: session.sessionId, cwd, mcpServers: [] });
if (sameLoad.sessionId !== session.sessionId) fail(`same-process session/load returned ${sameLoad.sessionId}`);
console.error(`[probe] same-process load OK meta=${JSON.stringify(sameLoad._meta)}`);

first.takeUpdates();
const sameTurn = await first.request(
  "session/prompt",
  sessionPrompt(session.sessionId, "Reply with exactly: SAME_BRIDGE_OK"),
);
const sameText = textOf(first.takeUpdates());
console.error(
  `[probe] same-process prompt stopReason=${sameTurn.stopReason} text=${JSON.stringify(sameText.slice(-80))}`,
);
if (!/SAME_BRIDGE_OK/.test(sameText)) fail("no SAME_BRIDGE_OK after same-process load");
first.close();
await waitExit(first.child);

// --- Bridge B: fresh process loads the same ACP session id -----------------
const second = connect("fresh");
await second.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
const freshLoad = await second.request("session/load", { sessionId: session.sessionId, cwd, mcpServers: [] });
if (freshLoad.sessionId !== session.sessionId) fail(`fresh-bridge session/load returned ${freshLoad.sessionId}`);
console.error(`[probe] fresh-bridge load OK meta=${JSON.stringify(freshLoad._meta)}`);

second.takeUpdates();
const freshTurn = await second.request(
  "session/prompt",
  sessionPrompt(session.sessionId, "Reply with exactly: FRESH_LOAD_OK"),
);
const freshText = textOf(second.takeUpdates());
console.error(
  `[probe] fresh-bridge prompt stopReason=${freshTurn.stopReason} text=${JSON.stringify(freshText.slice(-80))}`,
);
if (!/FRESH_LOAD_OK/.test(freshText)) fail("no FRESH_LOAD_OK after fresh-bridge load");
if (second.seenMethods.size > 0) {
  console.error(`[probe] client-facing server requests: ${[...second.seenMethods].join(",")}`);
}
second.close();

console.error("[probe] note: fresh-bridge load keeps the ACP session id but starts a new daemon");
console.error("[probe] note: conversation; daemon-level replay is Phase 2 (README)");
console.error("[probe] PASS");
process.exit(0);

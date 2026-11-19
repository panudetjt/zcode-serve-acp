#!/usr/bin/env bun
/**
 * Smoke: spawn the bridge (compiled binary if present, else bun src/bin.ts),
 * drive ACP over stdio: initialize → session/new (assert daemon models) →
 * short prompt (assert streamed updates + turn end).
 *
 * Usage: bun scripts/smoke.mjs [--prompt "text"] [--cwd /path]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const binary = path.join(repo, "dist", "zcode-serve-acp");
const cmd = existsSync(binary) ? binary : "bun";
const args = existsSync(binary) ? [] : [path.join(repo, "src", "bin.ts")];

const argOf = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
};
const prompt = argOf("--prompt", "Reply with exactly: BRIDGE_OK");
const cwd = argOf("--cwd", repo);

const child = spawn(cmd, args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

let nextId = 1;
const pending = new Map();
const updates = [];
child.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[smoke] non-JSON from bridge:", line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // server→client request (e.g. permission): auto-allow the LAST option (reject/allow mapping per ACP)
      const options = msg.params?.options ?? [];
      const choice = options[0]?.optionId ?? "allow";
      console.error(`[smoke] server request ${msg.method} → answer ${choice}`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { optionId: choice } }) + "\n");
      continue;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
      continue;
    }
    if (msg.method === "session/update") {
      updates.push(msg.params?.update);
      console.error(`[smoke] update: ${JSON.stringify(msg.params?.update).slice(0, 220)}`);
    }
  }
});

function request(method, params, timeoutMs = 180_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
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
  console.error(`[smoke] FAIL: ${msg}`);
  child.kill();
  process.exit(1);
};

const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
console.error(`[smoke] initialize → agentInfo=${JSON.stringify(init.agentInfo)} models-cap=${JSON.stringify(init.agentCapabilities)}`);
if (Number(init.protocolVersion) !== 1) fail(`protocolVersion ${init.protocolVersion}`);

const session = await request("session/new", { cwd, mcpServers: [] });
const models = session.models?.availableModels ?? [];
console.error(`[smoke] session/new → sessionId=${session.sessionId}`);
console.error(`[smoke] models (${models.length}): ${models.map((m) => m.modelId).join(" | ")}`);
if (models.length === 0) fail("daemon advertised no models (and fallback produced none)");
const configOptions = session.configOptions ?? [];
console.error(`[smoke] configOptions: ${configOptions.map((o) => `${o.id}=${o.currentValue ?? "?"} (${o.options?.length ?? 0} opts)`).join(" · ")}`);
const thoughtOpt = configOptions.find((o) => o.id === "reasoning" || o.id === "thought");
if (!thoughtOpt || (thoughtOpt.options?.length ?? 0) === 0) fail("no thought configOption — Effort panel will be empty");
console.error(`[smoke] set_config_option thought=high →`, JSON.stringify(await request("session/set_config_option", { sessionId: session.sessionId, configOptionId: "thought", currentValue: "high" })));

const result = await request(
  "session/prompt",
  {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: prompt }],
  },
  240_000,
);
console.error(`[smoke] prompt result: ${JSON.stringify(result)}`);
const textUpdates = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
const text = textUpdates.map((u) => u.content?.text ?? "").join("");
console.error(`[smoke] updates: ${updates.length} total, ${textUpdates.length} text chunks`);
console.log(text || "(no text)");

const ok = /BRIDGE_OK/.test(text) || textUpdates.length > 0;
console.error(`[smoke] ${ok ? "PASS" : "FAIL"} — models advertised: ${models.length}, text chunks: ${textUpdates.length}`);
child.kill();
process.exit(ok ? 0 : 1);

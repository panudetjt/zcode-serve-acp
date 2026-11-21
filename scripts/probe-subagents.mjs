#!/usr/bin/env bun
/**
 * Live full-loop probe for the subagent drill-down (PR #9):
 *   1. spawn the bridge → initialize → session/new
 *   2. prompt that forces a real subagent spawn
 *   3. assert the four acceptance points:
 *      a. a tool_call card with name "subagent" is emitted
 *      b. the card receives tool_call_update with non-empty rawOutput while
 *         it is still in_progress (live child activity → foldChild path)
 *      c. an agent_message_chunk batch summary ("Subagents — N running, …")
 *         arrives (session/subagents RPC path)
 *      d. the turn ends cleanly (stopReason end_turn)
 *
 * Runs against a real daemon (status.json discovery, same as the bridge);
 * NOT part of CI. Usage:
 *   bun scripts/probe-subagents.mjs [--bin PATH] [--cwd PATH] [--prompt TEXT]
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
const prompt = argOf(
  "--prompt",
  "Call your Agent tool ONCE (subagent, subagentType Explore) with this exact sub-prompt: " +
    "'List the file names in the current directory, then reply with one line: N files.' " +
    "Do not answer the question yourself and do not do the work inline — you MUST delegate it to the subagent, " +
    "then report the subagent's answer when it finishes.",
);

function daemonVersion() {
  const home = process.env.HOME ?? homedir();
  const dataRoot = process.env.ZCODE_DATA_BASE_DIR ?? home;
  const serverRoot = process.env.ZCODE_SERVER_ROOT ?? path.join(dataRoot, ".zcode", "server");
  try {
    return String(JSON.parse(readFileSync(path.join(serverRoot, "run", "status.json"), "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

const fail = (msg) => {
  console.error(`[probe] FAIL: ${msg}`);
  process.exit(1);
};

console.error(`[probe] daemon version: ${daemonVersion()}`);
console.error(`[probe] bridge: ${[cmd, ...args].join(" ")}`);
const child = spawn(cmd, args, {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZCODE_SERVE_ACP_DEBUG: "1" },
});
child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

let nextId = 1;
const pending = new Map();
let updates = [];

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
    if (msg.method === "session/update") {
      const update = msg.params?.update;
      if (update !== undefined) {
        updates.push(update);
        describe(update);
      }
    }
  }
});
child.on("exit", (code) => {
  if (pending.size > 0) fail(`bridge exited early (code ${code})`);
});

const describe = (update) => {
  if (update.sessionUpdate === "tool_call" && update.name === "subagent") {
    console.error(`[probe]   subagent CARD ${update.toolCallId} status=${update.status} title=${update.title}`);
  } else if (update.sessionUpdate === "tool_call_update" && update.name === "subagent") {
    const out = typeof update.rawOutput?.text === "string" ? update.rawOutput.text : "";
    const live = update.status === "in_progress" && out.length > 0;
    console.error(
      `[probe]   subagent UPDATE ${update.toolCallId} status=${update.status} rawOutputChars=${out.length}${live ? " (LIVE)" : ""}`,
    );
    if (live) console.error(`[probe]     tail: ${JSON.stringify(out.slice(-160))}`);
  } else if (update.sessionUpdate === "agent_message_chunk") {
    const text = typeof update.content?.text === "string" ? update.content.text : "";
    if (text.startsWith("Subagents —")) console.error(`[probe]   SUMMARY CHUNK: ${JSON.stringify(text)}`);
  }
};

const request = (method, params, timeoutMs = 300_000) => {
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
};

try {
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.error(`[probe] initialize → agentInfo=${JSON.stringify(init?.agentInfo)}`);

  const created = await request("session/new", { cwd, mcpServers: [] });
  const sessionId = created?.sessionId;
  if (!sessionId) fail(`session/new returned no sessionId: ${JSON.stringify(created)?.slice(0, 200)}`);
  console.error(`[probe] session ${sessionId}`);

  console.error(`[probe] prompting (${prompt.slice(0, 80)}…)`);
  const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  console.error(`[probe] turn end → stopReason=${result?.stopReason}`);

  // ---- acceptance checks ----
  const cards = updates.filter((u) => u.sessionUpdate === "tool_call" && u.name === "subagent");
  const cardIds = new Set(cards.map((u) => u.toolCallId));
  const cardUpdates = updates.filter((u) => u.sessionUpdate === "tool_call_update" && cardIds.has(u.toolCallId));
  const liveUpdates = cardUpdates.filter(
    (u) => u.status === "in_progress" && typeof u.rawOutput?.text === "string" && u.rawOutput.text.length > 0,
  );
  const settleUpdates = cardUpdates.filter(
    (u) =>
      (u.status === "completed" || u.status === "failed") &&
      typeof u.rawOutput?.text === "string" &&
      u.rawOutput.text.length > 0,
  );
  const summaries = updates.filter(
    (u) =>
      u.sessionUpdate === "agent_message_chunk" &&
      typeof u.content?.text === "string" &&
      u.content.text.startsWith("Subagents —"),
  );

  const check = (ok, label) => console.error(`[probe] ${ok ? "PASS" : "FAIL"}: ${label}`);
  check(cards.length > 0, `subagent card emitted (${cards.length})`);
  check(liveUpdates.length > 0, `live rawOutput while in_progress (${liveUpdates.length} updates)`);
  check(settleUpdates.length > 0, `settle update keeps rawOutput transcript (${settleUpdates.length})`);
  check(summaries.length > 0, `batch summary chunk (${summaries.length})`);
  check(result?.stopReason === "end_turn", `clean turn end (stopReason=${result?.stopReason})`);

  const ok =
    cards.length > 0 &&
    liveUpdates.length > 0 &&
    settleUpdates.length > 0 &&
    summaries.length > 0 &&
    result?.stopReason === "end_turn";
  console.error(`[probe] RESULT: ${ok ? "ALL PASS" : "SOME CHECKS FAILED"}`);
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  fail(String(err));
} finally {
  child.kill();
}

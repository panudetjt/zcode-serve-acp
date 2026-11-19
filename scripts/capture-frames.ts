#!/usr/bin/env bun
/**
 * Golden-frame capture — drives a REAL local `zcode serve` daemon through
 * short scripted turns, records every raw conversation frame plus the
 * pre-rewrite FrameTranslator's output per frame (the parity oracle), and
 * writes sanitized fixtures to test/fixtures/golden-frames/.
 *
 * Usage: bun scripts/capture-frames.ts [--out test/fixtures/golden-frames]
 *
 * Requires: a ready daemon (status.json state==="ready") — the script attaches
 * only, it never spawns. It creates one daemon session per scenario so state
 * cannot leak between fixtures. Prompts are deliberately innocuous; the script
 * auto-approves permission interactions (first allow-ish option) and answers
 * user-input interactions with the first option so turns complete.
 *
 * Re-capture policy (AGENTS.md): fixtures are the parity baseline for the
 * FrameTranslator. When the daemon protocol changes, re-run this script — the
 * then-current translator output becomes the new oracle. Never hand-edit a
 * fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectDaemon } from "../src/serve/daemon.ts";
import { ServeSession, type CreateSessionResult } from "../src/serve/session.ts";
import { FrameTranslator, type AcpUpdate, type FoldResult, type PendingInteraction } from "../src/translate.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_DIR = outIdx >= 0 ? path.resolve(args[outIdx + 1]!) : path.resolve(import.meta.dir, "../test/fixtures/golden-frames");
const DEBUG = process.env.ZCODE_SERVE_ACP_DEBUG === "1";
const log = (...parts: unknown[]) => {
  if (DEBUG) console.error("[capture]", ...parts);
};

interface Scenario {
  name: string;
  prompt: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "plain-text",
    prompt: "Reply with exactly this sentence and nothing else: The capture harness works correctly.",
  },
  {
    name: "tool-exec",
    prompt:
      "Use the shell/terminal tool to run exactly this command: echo capture-probe-1234 — then reply with just its output.",
  },
  {
    name: "question",
    prompt:
      "Use the AskUserQuestion tool to ask me which capture scenario I like most, with exactly two options: \"plain\" and \"tool\". Do not do anything else.",
  },
];

interface RecordedFrame {
  payload: unknown;
  oracle: FoldOracle;
}
interface FoldOracle {
  updates: AcpUpdate[];
  turnComplete: boolean;
  assistantSettled: boolean;
  hasActiveWork: boolean;
  turnFailed: boolean;
  turnCancelled?: boolean;
  errorMessage?: string;
  usage?: unknown;
  pendingInteractions?: PendingInteraction[];
}

interface ScenarioFixture {
  fixtureVersion: 1;
  scenario: string;
  prompt: string;
  daemonRuntime: string;
  frames: RecordedFrame[];
  lifecycle: unknown[];
  terminalReason: string;
  stopReason?: string;
  failure?: string;
}

const QUIET_MS = 5_000;
const TURN_TIMEOUT_MS = 180_000;

function sanitize(text: string, secrets: Array<[string, string]>): string {
  let out = text;
  for (const [secret, placeholder] of secrets) {
    if (secret.length > 0) out = out.split(secret).join(placeholder);
  }
  return out;
}

async function runScenario(scenario: Scenario, cwd: string, runtimeVersion: string): Promise<ScenarioFixture> {
  const daemon = await connectDaemon(process.env, log);
  const translator = new FrameTranslator(log);
  const frames: RecordedFrame[] = [];
  const lifecycle: unknown[] = [];
  const handled = new Set<string>();
  let daemonSession: CreateSessionResult | null = null;
  let inputId = "";
  const secrets: Array<[string, string]> = [
    [cwd, "/workspace"],
    [os.homedir(), "~"],
  ];

  const quietWait = { timer: null as Timer | null };
  const outcome = { done: false, reason: "", stopReason: "", failure: "" };

  const settle = (reason: string, stopReason: string, failure: string) => {
    if (outcome.done) return;
    if (quietWait.timer !== null) {
      clearTimeout(quietWait.timer);
      quietWait.timer = null;
    }
    outcome.done = true;
    outcome.reason = reason;
    outcome.stopReason = stopReason;
    outcome.failure = failure;
  };

  const autoAnswer = async (interaction: PendingInteraction): Promise<void> => {
    if (handled.has(interaction.interactionId)) return;
    handled.add(interaction.interactionId);
    const payload = (interaction.payload ?? {}) as Record<string, unknown>;
    const isElicitation =
      interaction.kind === "userInput" ||
      interaction.kind === "elicitation" ||
      payload.kind === "userInput" ||
      payload.kind === "elicitation" ||
      payload.toolName === "AskUserQuestion" ||
      payload.toolName === "ExitPlanMode";
    if (isElicitation) {
      let firstValue: string | undefined;
      const questions = (payload.questions ?? (payload.input as { questions?: unknown[] } | undefined)?.questions ?? []) as
        Array<Record<string, unknown>>;
      const firstOptions = (questions[0]?.options ?? payload.options) as
        | Array<{ value?: string; optionId?: string }>
        | undefined;
      firstValue = String(firstOptions?.[0]?.value ?? firstOptions?.[0]?.optionId ?? "accept");
      await session.resolveInteraction(interaction.interactionId, {
        action: "accept",
        content: { q0: firstValue },
        optionId: firstValue,
      });
    } else {
      const options = (payload.options ?? []) as Array<{ optionId?: string; kind?: string }>;
      const allow = options.find((o) => String(o.kind ?? "").includes("allow")) ?? options[0];
      await session.resolveInteraction(interaction.interactionId, {
        optionId: String(allow?.optionId ?? "allow"),
      });
    }
  };

  const session = new ServeSession(daemon, cwd, {
    onConversationFrame: (payload) => {
      const result = translator.fold(payload);
      frames.push({ payload, oracle: structuredClone(result) });
      const pending = result.pendingInteractions ?? [];
      for (const interaction of pending) void autoAnswer(interaction);
      if (result.turnFailed) {
        settle("failed", "error", result.errorMessage ?? "turn failed");
        return;
      }
      if (result.turnCancelled) {
        settle("cancelled", "cancelled", "");
        return;
      }
      if (result.turnComplete) {
        settle("complete", "end_turn", "");
        return;
      }
      if (result.assistantSettled && !result.hasActiveWork) {
        if (quietWait.timer !== null) clearTimeout(quietWait.timer);
        quietWait.timer = setTimeout(() => settle("quiet", "end_turn", ""), QUIET_MS);
        return;
      }
      if (result.hasActiveWork && quietWait.timer !== null) {
        clearTimeout(quietWait.timer);
        quietWait.timer = null;
      }
    },
    onLifecycle: (payload) => {
      lifecycle.push(payload);
      const p = payload as { state?: string; lastError?: { message?: string } | null; error?: string };
      if (p.state === "faulted" || p.lastError) {
        settle("faulted", "error", p.lastError?.message ?? p.error ?? "daemon session faulted");
        return;
      }
      if (p.state === "stopping" || p.state === "unloaded") {
        settle(`lifecycle:${p.state}`, "cancelled", "");
      }
    },
    onRequest: async (channelName, name, arg) => {
      log(`[capture] server request ${channelName}.${name}`);
      if (name.toLowerCase().includes("permission")) {
        const raw = (arg ?? {}) as {
          interactionId?: string;
          options?: Array<{ id?: string; optionId?: string; kind?: string }>;
        };
        const options = raw.options ?? [];
        const allow = options.find((o) => String(o.kind ?? "").includes("allow")) ?? options[0];
        const answer = allow ?? { optionId: "allow" };
        return raw.interactionId !== undefined
          ? { interactionId: raw.interactionId, answer }
          : { answer };
      }
      return {};
    },
    log,
  });

  daemonSession = await session.createSession();
  secrets.push([daemonSession.daemonSessionId, "SESSION_ID"]);
  translator.startTurn();
  inputId = (await session.sendPrompt(scenario.prompt)).inputId;
  secrets.push([inputId, "INPUT_ID"]);

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (!outcome.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!outcome.done) settle("timeout", "error", "capture turn exceeded 180s");

  const sanitizeValue = (value: unknown): unknown =>
    JSON.parse(sanitize(JSON.stringify(value), secrets));
  const fixture: ScenarioFixture = {
    fixtureVersion: 1,
    scenario: scenario.name,
    prompt: sanitize(scenario.prompt, secrets),
    daemonRuntime: runtimeVersion,
    frames: frames.map((f) => ({ payload: sanitizeValue(f.payload), oracle: sanitizeValue(f.oracle) })),
    lifecycle: lifecycle.map(sanitizeValue),
    terminalReason: outcome.reason,
    ...(outcome.stopReason !== "" ? { stopReason: outcome.stopReason } : {}),
    ...(outcome.failure !== "" ? { failure: outcome.failure } : {}),
  };
  return fixture;
}

const daemonInfo = await connectDaemon(process.env, log);
const runtimeVersion = daemonInfo.status.version ?? "unknown";

mkdirSync(OUT_DIR, { recursive: true });
const cwd = process.cwd();
for (const scenario of SCENARIOS) {
  console.error(`[capture] scenario ${scenario.name} …`);
  const fixture = await runScenario(scenario, cwd, runtimeVersion);
  const file = path.join(OUT_DIR, `${scenario.name}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(`[capture] ${scenario.name}: ${fixture.frames.length} frames → ${file} (${fixture.terminalReason})`);
}
console.error("[capture] done");
// Capture keeps WS channels open per scenario; exit explicitly so the
// long-lived sockets don't hold the event loop after the fixtures are written.
process.exit(0);

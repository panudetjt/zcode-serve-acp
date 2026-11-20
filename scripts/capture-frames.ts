#!/usr/bin/env bun
/**
 * Golden-frame capture — drives a REAL local `zcode serve` daemon through
 * short scripted turns, records every raw conversation frame plus the
 * CURRENT FrameTranslator's output per frame (the parity oracle), and writes
 * sanitized fixtures to test/fixtures/golden-frames/.
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
 * fixture. (The fixtures captured on 19 พ.ย. 2026 use the PRE-rewrite
 * translator as oracle; later re-captures use the current one.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Clock, Effect, Layer, type Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { Daemon } from "../src/serve/daemon.ts";
import { ServeSessionFactory, type CreateSessionResult, type ServeSession } from "../src/serve/session.ts";
import { Log } from "../src/log.ts";
import { FrameTranslator, type FoldResult, type PendingInteraction } from "../src/translate/translator.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_DIR =
  outIdx >= 0 ? path.resolve(args[outIdx + 1]!) : path.resolve(import.meta.dir, "../test/fixtures/golden-frames");
const DEBUG = process.env.ZCODE_SERVE_ACP_DEBUG === "1";

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
      'Use the AskUserQuestion tool to ask me which capture scenario I like most, with exactly two options: "plain" and "tool". Do not do anything else.',
  },
];

interface RecordedFrame {
  payload: unknown;
  oracle: FoldResult;
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

const runScenario = (
  scenario: Scenario,
  cwd: string,
  runtimeVersion: string,
): Effect.Effect<ScenarioFixture, unknown, Daemon | Log | ServeSessionFactory> =>
  Effect.gen(function* () {
    const log = yield* Log;
    const factory = yield* ServeSessionFactory;
    const translator = new FrameTranslator((...parts) => {
      if (DEBUG) console.error(...parts);
    });
    const frames: RecordedFrame[] = [];
    const lifecycle: unknown[] = [];
    const handled = new Set<string>();
    const secrets: Array<[string, string]> = [
      [cwd, "/workspace"],
      [os.homedir(), "~"],
    ];

    const outcome = { done: false, reason: "", stopReason: "", failure: "" };
    let quietFiber: Fiber.Fiber<void, never> | null = null;

    const settle = (reason: string, stopReason: string, failure: string) => {
      if (outcome.done) return;
      outcome.done = true;
      outcome.reason = reason;
      outcome.stopReason = stopReason;
      outcome.failure = failure;
    };

    const autoAnswer = (interaction: PendingInteraction): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
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
          const questions = (payload.questions ??
            (payload.input as { questions?: unknown[] } | undefined)?.questions ??
            []) as Array<Record<string, unknown>>;
          const firstOptions = (questions[0]?.options ?? payload.options) as
            | Array<{ value?: string; optionId?: string }>
            | undefined;
          const firstValue = String(firstOptions?.[0]?.value ?? firstOptions?.[0]?.optionId ?? "accept");
          yield* session.resolveInteraction(interaction.interactionId, {
            action: "accept",
            content: { q0: firstValue },
            optionId: firstValue,
          });
        } else {
          const options = (payload.options ?? []) as Array<{ optionId?: string; kind?: string }>;
          const allow = options.find((o) => String(o.kind ?? "").includes("allow")) ?? options[0];
          yield* session.resolveInteraction(interaction.interactionId, {
            optionId: String(allow?.optionId ?? "allow"),
          });
        }
      });

    let session!: ServeSession;

    const handlers = {
      onConversationFrame: (payload: unknown): Effect.Effect<void, unknown, never> =>
        Effect.gen(function* () {
          const result = translator.fold(payload);
          frames.push({ payload, oracle: structuredClone(result) });
          for (const interaction of result.pendingInteractions ?? []) {
            yield* Effect.forkDetach(autoAnswer(interaction));
          }
          if (result.turnFailed) return settle("failed", "error", result.errorMessage ?? "turn failed");
          if (result.turnCancelled === true) return settle("cancelled", "cancelled", "");
          if (result.turnComplete) return settle("complete", "end_turn", "");
          if (result.assistantSettled && !result.hasActiveWork) {
            quietFiber = yield* Effect.forkDetach(
              Effect.sleep(`${QUIET_MS} millis`).pipe(
                Effect.andThen(Effect.sync(() => settle("quiet", "end_turn", ""))),
              ) as Effect.Effect<void, never, never>,
            );
            return;
          }
          if (result.hasActiveWork && quietFiber !== null) {
            quietFiber = null; // detached fiber observes settle() idempotence
          }
        }),
      onLifecycle: (payload: unknown): Effect.Effect<void, unknown, never> =>
        Effect.sync(() => {
          lifecycle.push(payload);
          const p = payload as { state?: string; lastError?: { message?: string } | null; error?: string };
          if (p.state === "faulted" || p.lastError) {
            settle("faulted", "error", p.lastError?.message ?? p.error ?? "daemon session faulted");
          } else if (p.state === "stopping" || p.state === "unloaded") {
            settle(`lifecycle:${p.state}`, "cancelled", "");
          }
        }),
      onRequest: (channelName: string, name: string, arg: unknown): Effect.Effect<unknown, unknown, never> =>
        Effect.gen(function* () {
          yield* log.debug(`[capture] server request ${channelName}.${name}`);
          if (name.toLowerCase().includes("permission")) {
            const raw = (arg ?? {}) as {
              interactionId?: string;
              options?: Array<{ id?: string; optionId?: string; kind?: string }>;
            };
            const options = raw.options ?? [];
            const allow = options.find((o) => String(o.kind ?? "").includes("allow")) ?? options[0];
            const answer = allow ?? { optionId: "allow" };
            return raw.interactionId !== undefined ? { interactionId: raw.interactionId, answer } : { answer };
          }
          return {};
        }),
      onChildFrame: (childSessionId: string, payload: unknown): Effect.Effect<void, unknown, never> =>
        // Child frames (subagent drill-down) are not part of the parity oracle
        // — fold them so the translator sees the same stream a live session
        // would, but record nothing.
        Effect.sync(() => {
          translator.foldChild(childSessionId, payload);
        }),
      onClosed: (reason: string): Effect.Effect<void, unknown, never> =>
        Effect.sync(() => settle("channel closed", "error", `connection closed: ${reason}`)),
    };

    session = yield* factory.create(cwd, handlers);
    const created: CreateSessionResult = yield* session.createSession();
    secrets.push([created.daemonSessionId, "SESSION_ID"]);
    translator.startTurn();
    const { inputId } = yield* session.sendPrompt(scenario.prompt);
    secrets.push([inputId, "INPUT_ID"]);

    const deadline = (yield* Clock.currentTimeMillis) + TURN_TIMEOUT_MS;
    while (!outcome.done && (yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(250);
    }
    if (!outcome.done) settle("timeout", "error", "capture turn exceeded 180s");
    yield* session.dispose;

    const sanitizeValue = (value: unknown): unknown => JSON.parse(sanitize(JSON.stringify(value), secrets));
    return {
      fixtureVersion: 1 as const,
      scenario: scenario.name,
      prompt: sanitize(scenario.prompt, secrets),
      daemonRuntime: runtimeVersion,
      frames: frames.map((f) => ({ payload: sanitizeValue(f.payload), oracle: sanitizeValue(f.oracle) as FoldResult })),
      lifecycle: lifecycle.map(sanitizeValue),
      terminalReason: outcome.reason,
      ...(outcome.stopReason !== "" ? { stopReason: outcome.stopReason } : {}),
      ...(outcome.failure !== "" ? { failure: outcome.failure } : {}),
    } satisfies ScenarioFixture;
  });

const program = Effect.gen(function* () {
  const daemon = yield* Daemon;
  const connection = yield* daemon.connect;
  const runtimeVersion = connection.status.version ?? "unknown";
  const cwd = process.cwd();

  mkdirSync(OUT_DIR, { recursive: true });
  for (const scenario of SCENARIOS) {
    console.error(`[capture] scenario ${scenario.name} …`);
    const fixture = yield* runScenario(scenario, cwd, runtimeVersion);
    const file = path.join(OUT_DIR, `${scenario.name}.json`);
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.error(`[capture] ${scenario.name}: ${fixture.frames.length} frames → ${file} (${fixture.terminalReason})`);
  }
  console.error("[capture] done");
}).pipe(
  Effect.provide(ServeSessionFactory.layerNoDeps),
  Effect.provide(Daemon.layer),
  Effect.provide(
    Layer.mergeAll(Log.layerFromEnv, FetchHttpClient.layer, BunFileSystem.layer, BunSocket.layerWebSocketConstructor),
  ),
);

// Capture keeps WS channels open per scenario; runMain would wait on fibers —
// run and exit explicitly once fixtures are written.
const exitCode = await Effect.runPromiseExit(program).then(
  (exit) => {
    if (exit._tag === "Failure") {
      console.error("[capture] failed:", exit.cause);
      return 1;
    }
    return 0;
  },
  () => 1,
);
process.exit(exitCode);

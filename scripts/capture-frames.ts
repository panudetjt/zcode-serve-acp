#!/usr/bin/env bun
/**
 * Golden-frame capture — drives a REAL local `zcode serve` daemon through
 * short scripted turns, records every raw conversation frame plus the
 * CURRENT FrameTranslator's output per frame (the parity oracle), and writes
 * sanitized fixtures to test/fixtures/golden-frames/.
 *
 * Usage: bun scripts/capture-frames.ts [--out test/fixtures/golden-frames] [--only NAME]
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
 *
 * `--only NAME` captures a single scenario WITHOUT touching the others — used
 * to add the subagent fixture (20 พ.ย. 2026), whose oracle is inherently the
 * current translator: the child-session drill-down (foldChild) exists only in
 * the rewrite, so there is no pre-rewrite oracle for it. The subagent fixture
 * is therefore a current-behavior pin, not a parity gate; the three original
 * fixtures keep their pre-rewrite oracles untouched.
 *
 * Subagent recording: parent frames record `fold()` output as before; child
 * frames (routed by topic after subscribeChild) record `{ kind: "child",
 * childSessionId, payload, oracle: updates[] }` from `foldChild()`, in
 * chronological interleave with the parent frames so replay reproduces the
 * binding order. The capture mirrors production wiring — newChildren trigger
 * `subscribeChild`, settledChildren `unsubscribeChild` — which is why the
 * recorded child frames exist at all.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Clock, Effect, Layer, type Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { tolerate } from "../src/errors.ts";
import { BridgeExit } from "../src/serve/bridge.ts";
import { Daemon } from "../src/serve/daemon.ts";
import { ServeSessionFactory, type CreateSessionResult, type ServeSession } from "../src/serve/session.ts";
import { Log } from "../src/log.ts";
import {
  FrameTranslator,
  type AcpUpdate,
  type FoldResult,
  type PendingInteraction,
} from "../src/translate/translator.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_DIR =
  outIdx >= 0 ? path.resolve(args[outIdx + 1]!) : path.resolve(import.meta.dir, "../test/fixtures/golden-frames");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
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
  {
    name: "subagent",
    // The child must LIVE long enough for the subscribeChild round-trip to
    // complete before it settles — a reply-only child finishes in ~2s and no
    // child frame ever flows (vacuous fixture). Real work keeps it alive
    // 10-20s, matching the probe wording that produced 23-51 child updates.
    prompt:
      "Call your Agent tool ONCE (subagent, subagentType Explore) with this exact sub-prompt: " +
      "'List the file names in the current directory, then reply with one line: N files.' " +
      "Do not answer yourself and do no other work inline — you MUST delegate to the subagent, then report its answer.",
  },
];

interface ParentRecordedFrame {
  payload: unknown;
  oracle: FoldResult;
}

/** Child frames carry their own lighter oracle — `foldChild`'s updates only. */
interface ChildRecordedFrame {
  kind: "child";
  childSessionId: string;
  payload: unknown;
  oracle: AcpUpdate[];
}

type RecordedFrame = ParentRecordedFrame | ChildRecordedFrame;

const isChildFrame = (frame: RecordedFrame): frame is ChildRecordedFrame =>
  (frame as ChildRecordedFrame).kind === "child";

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
    // Child subscribe/unsubscribe requests, drained by the scenario's main
    // polling loop — NOT forked from inside the frame handler. The channel
    // dispatches frame handlers inline on its pump fiber, and fibers forked
    // there are starved while frames keep flowing (observed live: the
    // subscribe RPC never even started). The polling loop sleeps 250ms, so
    // draining there runs the RPCs reliably.
    const subscribeRequests: string[] = [];
    const unsubscribeRequests: string[] = [];
    // Child session ids are per-run random — sanitize them into stable
    // placeholders so fixtures stay diffable across re-captures.
    const childIdSeen = new Set<string>();

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
          // Mirror the production wiring: child sightings subscribe the child
          // conversation (that is what makes the recorded child frames exist),
          // settled children are released. MUST be forkDetach — the channel
          // dispatches event handlers INLINE (sequential order, channel.ts
          // EventFire), so yielding on a channel RPC here would block the
          // pump that delivers that RPC's own response → 30s RpcTimeout
          // (observed live before the fork).
          for (const childId of result.newChildren ?? []) {
            subscribeRequests.push(childId);
          }
          for (const childId of result.settledChildren ?? []) {
            unsubscribeRequests.push(childId);
          }
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
        Effect.sync(() => {
          // Record the child frame with its CURRENT foldChild output — the
          // drill-down oracle (no pre-rewrite equivalent exists).
          const oracle = translator.foldChild(childSessionId, payload).updates;
          if (!childIdSeen.has(childSessionId)) {
            childIdSeen.add(childSessionId);
            secrets.push([childSessionId, `CHILD_SESSION_ID_${childIdSeen.size}`]);
          }
          frames.push({ kind: "child", childSessionId, payload, oracle: structuredClone(oracle) });
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
      // Drain child subscription requests on the main fiber — see the queue
      // comment above for why this cannot live in the frame handler.
      for (const childId of subscribeRequests.splice(0)) {
        yield* tolerate(session.subscribeChild(childId), (cause) =>
          Effect.sync(() => console.error(`[capture] subscribeChild ${childId} failed: ${String(cause)}`)),
        );
      }
      for (const childId of unsubscribeRequests.splice(0)) {
        yield* session.unsubscribeChild(childId);
      }
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
      frames: frames.map((f) =>
        isChildFrame(f)
          ? {
              kind: "child" as const,
              childSessionId: sanitizeValue(f.childSessionId) as string,
              payload: sanitizeValue(f.payload),
              oracle: sanitizeValue(f.oracle) as AcpUpdate[],
            }
          : { payload: sanitizeValue(f.payload), oracle: sanitizeValue(f.oracle) as FoldResult },
      ),
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
  const scenarios = ONLY === undefined ? SCENARIOS : SCENARIOS.filter((s) => s.name === ONLY);
  if (scenarios.length === 0) {
    console.error(`[capture] no scenario matches --only ${ONLY} (known: ${SCENARIOS.map((s) => s.name).join(", ")})`);
    process.exit(2);
  }
  for (const scenario of scenarios) {
    // The subagent scenario races subscribeConversationV4 (host runs a
    // provider-registry refresh inside it) against the child's lifetime — a
    // short child settles before the subscription lands and no child frame
    // ever flows. Retry until the capture wins the race; the replay test's
    // guard flags a fixture that gave up with zero child frames.
    const maxAttempts = scenario.name === "subagent" ? 4 : 1;
    let fixture: ScenarioFixture | undefined;
    let fallback: ScenarioFixture | undefined;
    for (let attempt = 1; attempt <= maxAttempts && fixture === undefined; attempt++) {
      if (attempt > 1) {
        console.error(`[capture] ${scenario.name}: previous attempt captured no child frames — retrying`);
        yield* Effect.sleep("3 seconds");
      }
      console.error(`[capture] scenario ${scenario.name} … (attempt ${attempt}/${maxAttempts})`);
      const candidate = yield* runScenario(scenario, cwd, runtimeVersion);
      const childFrameCount = candidate.frames.filter(isChildFrame).length;
      const hasChildFrames = candidate.frames.some((f) => isChildFrame(f) && f.oracle.length > 0);
      console.error(
        `[capture] attempt ${attempt}: ${candidate.frames.length} frames (child ${childFrameCount}) → ${candidate.terminalReason}`,
      );
      fallback = candidate;
      // A child-frame capture is precious (the drill-down race does not always
      // go our way) — accept it even if the channel closed mid-turn: replay
      // only replays the recorded frames.
      if (scenario.name !== "subagent" || (hasChildFrames && candidate.terminalReason !== "timeout")) {
        fixture = candidate;
      }
    }
    fixture ??= fallback!;
    const file = path.join(OUT_DIR, `${scenario.name}.json`);
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.error(`[capture] ${scenario.name}: ${fixture.frames.length} frames → ${file} (${fixture.terminalReason})`);
  }
  console.error("[capture] done");
}).pipe(
  Effect.provide(ServeSessionFactory.layerNoDeps),
  Effect.provide(Daemon.layer),
  Effect.provide(BridgeExit.layer),
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

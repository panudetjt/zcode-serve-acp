// probe: dump the model registry a fresh daemon session reports (read-only).
//
// This is the end-to-end check for "which accounts does the daemon serve
// right now" (e.g. account:zai-start-plan going missing) without touching
// the T3 UI: it runs the same createSession the bridge does on
// session/new and times each phase. Non-zero exit = the daemon path is
// broken (attach, capability, WS, or RPC failure), which is what a
// `server.refreshProviders` timeout looks like from inside.
//
//   bun scripts/probe-models.mjs
//
// Companion one-liners (manual diagnosis):
//   daemon restart history: python3 -c "import json;print(json.load(open(
//     '$HOME/.zcode/server/run/status.json'))['lastExitReason'])"
//   daemon HTTP liveness:   curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
//     -H "authorization: Bearer $(cat ~/.zcode/server/run/ingress-token)" \
//     "http://127.0.0.1:$(python3 -c "import json;print(json.load(open('$HOME/.zcode/server/run/status.json'))['port'])")/api/server-info"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Clock, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Daemon } from "../src/serve/daemon.ts";
import { BridgeExit } from "../src/serve/bridge.ts";
import { Log } from "../src/log.ts";
import { ServeSessionFactory } from "../src/serve/session.ts";

const PlatformLayer = Layer.mergeAll(
  Log.layerFromEnv,
  FetchHttpClient.layer,
  BunFileSystem.layer,
  BunSocket.layerWebSocketConstructor,
);

const timed = (label, effect) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    const end = yield* Clock.currentTimeMillis;
    console.log(`probe: ${label}: ${end - start}ms`);
    return value;
  });

const Main = Effect.gen(function* () {
  const sessions = yield* ServeSessionFactory;
  const session = yield* sessions.create(process.cwd(), {
    onConversationFrame: () => Effect.void,
    onLifecycle: () => Effect.void,
    onRequest: () => Effect.succeed({}),
    onClosed: () => Effect.void,
  });

  const created = yield* timed("createSession", session.createSession());
  console.log("probe: session:", created.daemonSessionId);
  console.log("probe: current model:", created.currentModel ?? "(none)");

  const byProvider = new Map();
  for (const model of created.models) {
    const models = byProvider.get(model.providerId) ?? [];
    models.push(model.modelId);
    byProvider.set(model.providerId, models);
  }
  console.log("probe: models by provider:");
  for (const [providerId, models] of byProvider) {
    console.log(`  ${providerId}: ${models.join(", ")}`);
  }
  for (const providerId of byProvider.keys()) {
    if (providerId.includes("start-plan")) {
      console.log(`probe: start-plan account present: ${providerId}`);
    }
  }
  if (![...byProvider.keys()].some((k) => k.includes("start-plan"))) {
    console.log("probe: start-plan account MISSING from the registry snapshot");
  }

  yield* session.dispose;
}).pipe(Effect.timeout("60 seconds"));

const AppLayer = ServeSessionFactory.layerNoDeps.pipe(
  Layer.provide(BridgeExit.layer),
  Layer.provide(Daemon.layer),
  Layer.provide(PlatformLayer),
);

BunRuntime.runMain(
  Effect.provide(
    Main,
    Layer.merge(AppLayer, PlatformLayer),
  ),
);

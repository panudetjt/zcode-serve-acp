import { describe, expect, test } from "bun:test";
import { Clock, Duration, Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { FileSystem } from "effect/FileSystem";
import { Log } from "../src/log.ts";
import { Daemon } from "../src/serve/daemon.ts";

/**
 * The readiness loop's deadline paths (30s budget) and the waiting log, driven
 * by a fake Clock: sleep advances the fake now by the slept duration (with a
 * macrotask yield so the detached spawn's async 'error' event can land), so
 * the 30s loop completes in milliseconds of real time.
 *
 * Waiver — agent-patterns/effect.md §Testing names `TestClock` for
 * deterministic time. TestClock advances only on `TestClock.adjust` and does
 * not yield the event loop, so the detached child process's async 'error'
 * event could never land while the loop is suspended and the SpawnError path
 * would be unreachable. Guard: the fake clock's only real-time dependency is a
 * `setTimeout(…, 0)` macrotask — the code under test observes fake `now` only.
 */

const makeFakeClock = () => {
  let now = 1_000_000;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration: Duration.Duration) =>
      Effect.promise(() =>
        new Promise<void>((res) => setTimeout(res, 0)).then(() => {
          now += Duration.toMillis(duration);
        }),
      ),
  };
  return clock;
};

const readyStatus = JSON.stringify({ state: "ready", host: "127.0.0.1", port: 54321 });

const statusFs = {
  exists: () => Effect.succeed(false),
  readFileString: (file: string) => {
    if (file.endsWith("status.json")) return Effect.succeed(readyStatus);
    if (file.endsWith("ingress-token")) return Effect.succeed("tok");
    return Effect.fail(new Error("File not found"));
  },
} as unknown as FileSystem;

const httpAlways = (status: number) =>
  HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, new Response("nope", { status }))));

const runConnect = (fakeClock: Clock.Clock, client: HttpClient.HttpClient = httpAlways(500)) =>
  Effect.gen(function* () {
    const daemon = yield* Daemon;
    return yield* daemon.connect();
  }).pipe(
    Effect.provideService(Clock.Clock, fakeClock),
    Effect.provide(Daemon.layer),
    Effect.provide(Layer.succeed(FileSystem, statusFs)),
    Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Effect.provide(Log.layerQuiet),
  );

describe("Daemon readiness loop (fake clock)", () => {
  const withBin = async (bin: string, body: () => Promise<void>) => {
    const original = process.env.ZCODE_SERVE_BIN;
    process.env.ZCODE_SERVE_BIN = bin;
    try {
      await body();
    } finally {
      if (original !== undefined) process.env.ZCODE_SERVE_BIN = original;
      else delete process.env.ZCODE_SERVE_BIN;
    }
  };

  test("deadline with a failed detached spawn surfaces the spawn failure (SpawnError)", async () => {
    await withBin("/nonexistent-zcode-dir/nope-bin", async () => {
      const err = await Effect.runPromise(Effect.flip(runConnect(makeFakeClock())));
      expect(err._tag).toBe("SpawnError");
      expect(err.message).toContain("spawning /nonexistent-zcode-dir/nope-bin serve failed");
    });
  });

  test("deadline without a spawn failure surfaces DiscoveryError", async () => {
    await withBin("/usr/bin/true", async () => {
      // Network-level probe failure also exercises the probe's orElseSucceed arm.
      const failingHttp = HttpClient.make((req) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, cause: new Error("network down") }),
          }),
        ),
      );
      const err = await Effect.runPromise(Effect.flip(runConnect(makeFakeClock(), failingHttp)));
      expect(err._tag).toBe("DiscoveryError");
      expect(err.message).toContain("did not report a ready daemon");
    });
  });

  test("not-ready status logs a waiting line, then the retry probe attaches", async () => {
    await withBin("/usr/bin/true", async () => {
      const debugCalls: string[] = [];
      const log: Log["Service"] = {
        debugSync: (...parts) => {
          debugCalls.push(parts.map(String).join(" "));
        },
        debug: (...parts) =>
          Effect.sync(() => {
            debugCalls.push(parts.map(String).join(" "));
          }),
        warn: () => Effect.void,
      };
      let probes = 0;
      const flakyHttp = HttpClient.make((req) => {
        probes++;
        // probes #1 (connect's initial check) and #2 (wait-loop iter 1) fail;
        // iter 2 attaches — the waiting log runs between those two iterations.
        const status = probes <= 2 ? 503 : 200;
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status })));
      });
      const conn = await Effect.runPromise(
        Effect.gen(function* () {
          const daemon = yield* Daemon;
          return yield* daemon.connect();
        }).pipe(
          Effect.provideService(Clock.Clock, makeFakeClock()),
          Effect.provide(Daemon.layer),
          Effect.provide(Layer.succeed(FileSystem, statusFs)),
          Effect.provide(Layer.succeed(HttpClient.HttpClient, flakyHttp)),
          Effect.provide(Layer.succeed(Log, log)),
        ),
      );
      expect(conn.status.host).toBe("127.0.0.1");
      expect(conn.token).toBe("tok");
      expect(debugCalls.some((l) => l.includes("[daemon] waiting: state=ready"))).toBe(true);
    });
  });

  test("empty token probes without an auth header", async () => {
    await withBin("/usr/bin/true", async () => {
      const emptyTokenFs = {
        exists: () => Effect.succeed(false),
        readFileString: (file: string) => {
          if (file.endsWith("status.json")) return Effect.succeed(readyStatus);
          if (file.endsWith("ingress-token")) return Effect.succeed("   \n");
          return Effect.fail(new Error("File not found"));
        },
      } as unknown as FileSystem;
      const authHeaders: string[] = [];
      let probes = 0;
      const spyingHttp = HttpClient.make((req) => {
        probes++;
        authHeaders.push(req.headers["authorization"] ?? "(none)");
        const status = probes <= 2 ? 503 : 200;
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status })));
      });
      const conn = await Effect.runPromise(
        Effect.gen(function* () {
          const daemon = yield* Daemon;
          return yield* daemon.connect();
        }).pipe(
          Effect.provideService(Clock.Clock, makeFakeClock()),
          Effect.provide(Daemon.layer),
          Effect.provide(Layer.succeed(FileSystem, emptyTokenFs)),
          Effect.provide(Layer.succeed(HttpClient.HttpClient, spyingHttp)),
          Effect.provide(Log.layerQuiet),
        ),
      );
      expect(conn.token).toBe("");
      expect(authHeaders.every((h) => h === "(none)")).toBe(true);
    });
  });

  test("unreadable status files keep the daemon unready until the deadline", async () => {
    await withBin("/usr/bin/true", async () => {
      const failingFs = {
        exists: () => Effect.succeed(false),
        readFileString: () => Effect.fail(new Error("EACCES")),
      } as unknown as FileSystem;
      const err = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            const daemon = yield* Daemon;
            return yield* daemon.connect();
          }).pipe(
            Effect.provideService(Clock.Clock, makeFakeClock()),
            Effect.provide(Daemon.layer),
            Effect.provide(Layer.succeed(FileSystem, failingFs)),
            Effect.provide(Layer.succeed(HttpClient.HttpClient, httpAlways(500))),
            Effect.provide(Log.layerQuiet),
          ),
        ),
      );
      expect(err._tag).toBe("DiscoveryError");
    });
  });
});

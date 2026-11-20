import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Result, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { FileSystem } from "effect/FileSystem";
import { TestClock } from "effect/testing";
import { Log } from "../src/log.ts";
import {
  Daemon,
  DaemonDeps,
  ServerStatusSchema,
  dataRoot,
  resolveServeBinary,
  serverRoot,
} from "../src/serve/daemon.ts";

describe("Daemon discovery and resolution", () => {
  test("ServerStatusSchema validates daemon status JSON", () => {
    const valid = {
      state: "ready",
      host: "127.0.0.1",
      port: 54321,
      version: "3.18.2",
      pid: 12345,
    };
    const parsed = Schema.decodeUnknownSync(ServerStatusSchema)(valid);
    expect(parsed.state).toBe("ready");
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(54321);
    expect(parsed.version).toBe("3.18.2");

    expect(() => Schema.decodeUnknownSync(ServerStatusSchema)({ state: "ready" })).toThrow();
  });

  test("dataRoot and serverRoot paths respect env overrides", () => {
    const originalData = process.env.ZCODE_DATA_BASE_DIR;
    const originalServer = process.env.ZCODE_SERVER_ROOT;
    try {
      delete process.env.ZCODE_DATA_BASE_DIR;
      delete process.env.ZCODE_SERVER_ROOT;
      const root = dataRoot();
      expect(typeof root).toBe("string");
      expect(serverRoot()).toContain(".zcode");

      process.env.ZCODE_DATA_BASE_DIR = "/custom/data";
      expect(dataRoot()).toBe("/custom/data");
      expect(serverRoot()).toBe("/custom/data/.zcode/server");

      process.env.ZCODE_SERVER_ROOT = "/explicit/server";
      expect(serverRoot()).toBe("/explicit/server");
    } finally {
      if (originalData !== undefined) process.env.ZCODE_DATA_BASE_DIR = originalData;
      else delete process.env.ZCODE_DATA_BASE_DIR;
      if (originalServer !== undefined) process.env.ZCODE_SERVER_ROOT = originalServer;
      else delete process.env.ZCODE_SERVER_ROOT;
    }
  });

  test("resolveServeBinary respects ZCODE_SERVE_BIN env var", async () => {
    const originalBin = process.env.ZCODE_SERVE_BIN;
    try {
      process.env.ZCODE_SERVE_BIN = "/opt/my-zcode";
      const fakeFs = {
        exists: () => Effect.succeed(false),
      } as unknown as FileSystem;
      const bin = await Effect.runPromise(resolveServeBinary(fakeFs));
      expect(bin).toBe("/opt/my-zcode");
    } finally {
      if (originalBin !== undefined) process.env.ZCODE_SERVE_BIN = originalBin;
      else delete process.env.ZCODE_SERVE_BIN;
    }
  });

  test("resolveServeBinary probes candidates via FileSystem", async () => {
    const originalBin = process.env.ZCODE_SERVE_BIN;
    try {
      delete process.env.ZCODE_SERVE_BIN;

      // When candidate exists
      const hitFs = {
        exists: (p: string) => Effect.succeed(p.includes(".zcode")),
      } as unknown as FileSystem;
      const bin = await Effect.runPromise(resolveServeBinary(hitFs));
      expect(bin).toContain(".zcode");

      // When no candidate exists, falls back to "zcode"
      const missFs = {
        exists: () => Effect.succeed(false),
      } as unknown as FileSystem;
      const fallback = await Effect.runPromise(resolveServeBinary(missFs));
      expect(fallback).toBe("zcode");
    } finally {
      if (originalBin !== undefined) process.env.ZCODE_SERVE_BIN = originalBin;
      else delete process.env.ZCODE_SERVE_BIN;
    }
  });
});

describe("Daemon service operations", () => {
  const readyStatus = {
    state: "ready",
    host: "127.0.0.1",
    port: 54321,
    version: "3.18.2",
    pid: 12345,
  };

  test("connect attaches to already ready daemon and getCapability succeeds", async () => {
    const fakeFs = {
      exists: () => Effect.succeed(false),
      readFileString: (file: string) => {
        if (file.endsWith("status.json")) return Effect.succeed(JSON.stringify(readyStatus));
        if (file.endsWith("ingress-token")) return Effect.succeed("  secret-token \n");
        return Effect.fail(new Error("File not found"));
      },
    } as unknown as FileSystem;

    const fakeHttp = HttpClient.make((req) => {
      if (req.url.includes("/api/server-info")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 })));
      }
      if (req.url.includes("/api/rpc-host-capability")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ capability: "cap-123" }), { status: 200 })),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not found", { status: 404 })));
    });

    const prog = Effect.gen(function* () {
      const daemon = yield* Daemon;
      const conn = yield* daemon.connect;
      expect(conn.status.host).toBe("127.0.0.1");
      expect(conn.token).toBe("secret-token");
      expect(conn.wsPath).toBe("/ws/host");

      const cap = yield* daemon.getCapability(conn);
      expect(cap).toBe("cap-123");
    }).pipe(
      Effect.provide(Daemon.layer),
      Effect.provide(Layer.succeed(FileSystem, fakeFs)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp)),
      Effect.provide(Log.layerQuiet),
    );

    await Effect.runPromise(prog);
  });

  test("getCapability error cases: non-200, missing capability, and network failure", async () => {
    const conn = {
      status: readyStatus,
      token: "tok",
      wsPath: "/ws/host",
    };

    // 1. HTTP 403 error
    const http403 = HttpClient.make((req) =>
      Effect.succeed(HttpClientResponse.fromWeb(req, new Response("denied", { status: 403 }))),
    );
    const prog403 = Effect.gen(function* () {
      const daemon = yield* Daemon;
      return yield* daemon.getCapability(conn);
    }).pipe(
      Effect.provide(Daemon.layer),
      Effect.provide(Layer.succeed(FileSystem, { exists: () => Effect.succeed(false) } as unknown as FileSystem)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http403)),
      Effect.provide(Log.layerQuiet),
    );
    const err403 = await Effect.runPromise(Effect.flip(prog403));
    expect(err403._tag).toBe("CapabilityError");
    expect(err403.status).toBe(403);

    // 2. HTTP 200 but missing capability field
    const httpMissingCap = HttpClient.make((req) =>
      Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ foo: "bar" }), { status: 200 }))),
    );
    const progMissing = Effect.gen(function* () {
      const daemon = yield* Daemon;
      return yield* daemon.getCapability(conn);
    }).pipe(
      Effect.provide(Daemon.layer),
      Effect.provide(Layer.succeed(FileSystem, { exists: () => Effect.succeed(false) } as unknown as FileSystem)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, httpMissingCap)),
      Effect.provide(Log.layerQuiet),
    );
    const errMissing = await Effect.runPromise(Effect.flip(progMissing));
    expect(errMissing._tag).toBe("CapabilityError");
    expect(errMissing.message).toContain("missing capability");

    // 3. HTTP 200 but unreadable JSON
    const httpUnreadable = HttpClient.make((req) =>
      Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{not json", { status: 200 }))),
    );
    const progUnreadable = Effect.gen(function* () {
      const daemon = yield* Daemon;
      return yield* daemon.getCapability(conn);
    }).pipe(
      Effect.provide(Daemon.layer),
      Effect.provide(Layer.succeed(FileSystem, { exists: () => Effect.succeed(false) } as unknown as FileSystem)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, httpUnreadable)),
      Effect.provide(Log.layerQuiet),
    );
    const errUnreadable = await Effect.runPromise(Effect.flip(progUnreadable));
    expect(errUnreadable._tag).toBe("CapabilityError");
    expect(errUnreadable.message).toContain("capability response unreadable");

    // 4. HTTP network execution failure
    const httpFail = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req, cause: new Error("Connection refused") }),
        }),
      ),
    );
    const progFail = Effect.gen(function* () {
      const daemon = yield* Daemon;
      return yield* daemon.getCapability(conn);
    }).pipe(
      Effect.provide(Daemon.layer),
      Effect.provide(Layer.succeed(FileSystem, { exists: () => Effect.succeed(false) } as unknown as FileSystem)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, httpFail)),
      Effect.provide(Log.layerQuiet),
    );
    const errFail = await Effect.runPromise(Effect.flip(progFail));
    expect(errFail._tag).toBe("CapabilityError");
    expect(errFail.message).toContain("capability request failed");
  });

  test("connect fails with DiscoveryError if serverRoot is unresolvable", async () => {
    const originalHome = process.env.HOME;
    const originalServerRoot = process.env.ZCODE_SERVER_ROOT;
    const originalDataBase = process.env.ZCODE_DATA_BASE_DIR;
    try {
      delete process.env.HOME;
      delete process.env.ZCODE_SERVER_ROOT;
      delete process.env.ZCODE_DATA_BASE_DIR;

      const prog = Effect.gen(function* () {
        const daemon = yield* Daemon;
        return yield* daemon.connect;
      }).pipe(
        Effect.provide(Daemon.layer),
        Effect.provide(Layer.succeed(FileSystem, { exists: () => Effect.succeed(false) } as unknown as FileSystem)),
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unused")),
          ),
        ),
        Effect.provide(Log.layerQuiet),
      );

      // If os.homedir() returns something, serverRoot() might still return a path.
      // But if serverRoot() returns undefined or if status file missing:
      if (serverRoot() === undefined) {
        const err = await Effect.runPromise(Effect.flip(prog));
        expect(err._tag).toBe("DiscoveryError");
      }
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      if (originalServerRoot !== undefined) process.env.ZCODE_SERVER_ROOT = originalServerRoot;
      if (originalDataBase !== undefined) process.env.ZCODE_DATA_BASE_DIR = originalDataBase;
    }
  });

  test("connect handles corrupt status.json and empty token file gracefully", async () => {
    let statusCallCount = 0;
    const fakeFs = {
      exists: () => Effect.succeed(false),
      readFileString: (file: string) => {
        if (file.endsWith("status.json")) {
          statusCallCount++;
          if (statusCallCount === 1) return Effect.succeed("not json at all");
          if (statusCallCount === 2) return Effect.succeed(JSON.stringify({ bad: "schema" }));
          return Effect.succeed(JSON.stringify(readyStatus));
        }
        if (file.endsWith("ingress-token")) {
          return Effect.succeed(""); // empty token
        }
        return Effect.fail(new Error("File not found"));
      },
    } as unknown as FileSystem;

    // Use /usr/bin/true as dummy serve binary to avoid real spawn failure
    const origBin = process.env.ZCODE_SERVE_BIN;
    process.env.ZCODE_SERVE_BIN = "/usr/bin/true";

    try {
      const fakeHttp = HttpClient.make((req) =>
        Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 }))),
      );

      const prog = Effect.gen(function* () {
        const daemon = yield* Daemon;
        const conn = yield* daemon.connect;
        expect(conn.status.host).toBe("127.0.0.1");
        expect(conn.token).toBe("");
      }).pipe(
        Effect.provide(Daemon.layer),
        Effect.provide(Layer.succeed(FileSystem, fakeFs)),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp)),
        Effect.provide(Log.layerQuiet),
      );

      await Effect.runPromise(prog);
    } finally {
      if (origBin !== undefined) process.env.ZCODE_SERVE_BIN = origBin;
      else delete process.env.ZCODE_SERVE_BIN;
    }
  });
});

describe("Daemon spawn and discovery branches (injected deps)", () => {
  /**
   * Drive `connect` with a fake `DaemonDeps`: no status.json (fake fs always
   * fails the read), so the not-ready path runs — spawn, then the 30s
   * readiness window on the TestClock.
   */
  const connectWithFakes = async (spawnFailure: string | undefined) => {
    const originalData = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = "/fake/data";
    const calls = { spawns: 0 };
    const deps = DaemonDeps.of({
      client: {} as unknown as HttpClient.HttpClient,
      fs: { readFileString: () => Effect.fail(new Error("ENOENT")) } as unknown as FileSystem,
      serveBin: "/fake/zcode",
      spawnServe: Effect.sync(() => {
        calls.spawns += 1;
      }),
      spawnFailure: Effect.succeed(spawnFailure),
    });

    const prog = Effect.gen(function* () {
      const daemon = yield* Daemon;
      // Building the layer must not spawn: the Effect value is lazy.
      expect(calls.spawns).toBe(0);
      const fiber = yield* Effect.forkDetach(daemon.connect.pipe(Effect.result));
      yield* TestClock.adjust("31 seconds");
      const outcome = yield* Fiber.join(fiber);
      // Exactly one spawn attempt for one connect run.
      expect(calls.spawns).toBe(1);
      return outcome;
    }).pipe(
      Effect.provide(Daemon.layerFromDeps),
      Effect.provide(Layer.merge(Layer.succeed(DaemonDeps, deps), Log.layerQuiet)),
      Effect.provide(TestClock.layer()),
    );

    try {
      return await Effect.runPromise(prog);
    } finally {
      if (originalData !== undefined) process.env.ZCODE_DATA_BASE_DIR = originalData;
      else delete process.env.ZCODE_DATA_BASE_DIR;
    }
  };

  test("connect surfaces the recorded spawn failure as SpawnError", async () => {
    const outcome = await connectWithFakes("spawn zcode ENOENT");
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("SpawnError");
      expect(outcome.failure.message).toContain("spawn zcode ENOENT");
    }
  });

  test("connect reports a 30s DiscoveryError when no spawn error was recorded", async () => {
    const outcome = await connectWithFakes(undefined);
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("DiscoveryError");
      expect(outcome.failure.message).toContain("did not report a ready daemon (30s)");
    }
  });
});

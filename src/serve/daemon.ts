/**
 * `zcode serve` daemon discovery + startup (Daemon service).
 *
 * Contract (ground-truthed against server-core.js 3.18.2 + the owner's PR
 * #34713): status at `~/.zcode/server/run/status.json` (trust `state ===
 * "ready"` + probe `GET /api/server-info`), ingress token at
 * `~/.zcode/server/run/ingress-token`, host capability via
 * `POST /api/rpc-host-capability` (Bearer token; 30s TTL, single use — fetch
 * right before the WS upgrade). If no ready daemon: spawn `zcode serve`
 * detached and poll (250ms, 30s budget). The daemon outlives the bridge.
 *
 * Files go through the platform `FileSystem` service and HTTP through
 * `HttpClient`, so tests can inject fakes for both. Malformed status/token
 * files are tolerated as "not ready" (pre-rewrite behavior).
 *
 * Pre-rewrite bug fixed here: the detached spawn had no `error` listener, so
 * a spawn failure surfaced only as the 30s readiness timeout — now the error
 * fails the connect immediately.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { HttpClient, HttpClientRequest } from "effect/http";
import { CapabilityError, DiscoveryError, SpawnError, renderError, tolerate } from "../errors.ts";
import { Log } from "../log.ts";

export interface ServerStatus {
  state: string;
  host: string;
  port: number;
  version?: string;
  pid?: number;
}

export const ServerStatusSchema = Schema.Struct({
  state: Schema.String,
  host: Schema.String,
  port: Schema.Number,
  version: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
});

export interface DaemonConnection {
  readonly status: ServerStatus;
  readonly token: string;
  /** ws:// path — fetch a fresh capability right before each WS dial */
  readonly wsPath: string;
}

class DaemonDeps extends Context.Service<DaemonDeps, {
  readonly client: HttpClient.HttpClient;
  readonly fs: FileSystem;
  readonly serveBin: string;
  /** spawn `serve` detached; resolves immediately, daemon keeps running */
  readonly spawnServe: () => Effect.Effect<void, SpawnError>;
  /** first async spawn error, if the detached spawn already failed */
  readonly spawnFailure: Effect.Effect<string | undefined>;
}>()("zcode-serve-acp/internal/DaemonDeps") {
  static readonly layer: Layer.Layer<DaemonDeps, never, HttpClient.HttpClient | FileSystem> = Layer.effect(
    DaemonDeps,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem;
      const serveBin = resolveServeBinary();
      let spawnError: string | undefined;

      const spawnServe = Effect.fn("DaemonDeps.spawnServe")(function* () {
        yield* Effect.try({
          try: () => {
            const child = nodeSpawn(serveBin, ["serve"], {
              env: process.env,
              detached: true,
              stdio: "ignore",
            });
            // Pre-rewrite bug fix: record the async spawn error so the
            // readiness loop can fail fast instead of waiting out 30s.
            child.on("error", (error) => {
              spawnError ??= error.message;
            });
            // The daemon must outlive the bridge — fully detach.
            child.unref();
          },
          catch: (cause) =>
            new SpawnError({ bin: serveBin, message: renderError(cause) }),
        });
      });

      return DaemonDeps.of({
        client,
        fs,
        serveBin,
        spawnServe,
        spawnFailure: Effect.sync(() => spawnError),
      });
    }),
  );
}

export class Daemon extends Context.Service<Daemon, {
  /** Attach to a ready daemon, spawning one if none is up. */
  connect(): Effect.Effect<DaemonConnection, DiscoveryError | SpawnError>
  /** Fresh single-use host capability token (30s TTL) — call right before each WS dial. */
  getCapability(connection: DaemonConnection): Effect.Effect<string, CapabilityError>
}>()("zcode-serve-acp/Daemon") {
  static readonly layer: Layer.Layer<Daemon, never, HttpClient.HttpClient | FileSystem | Log> = Layer.effect(
    Daemon,
    Effect.gen(function* () {
      const deps = yield* DaemonDeps;
      const log = yield* Log;

      const readFile = (file: string) =>
        deps.fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));

      // Malformed/unready status → undefined (tolerated, keeps polling).
      const readStatus = Effect.fn("Daemon.readStatus")(function* (rootDir: string) {
        const text = yield* readFile(path.join(rootDir, "run", "status.json"));
        if (text === undefined) return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
        const result = yield* Effect.result(Schema.decodeUnknownEffect(ServerStatusSchema)(parsed));
        return Result.isSuccess(result) ? result.success : undefined;
      });

      const readToken = Effect.fn("Daemon.readToken")(function* (rootDir: string) {
        const text = yield* readFile(path.join(rootDir, "run", "ingress-token"));
        return text === undefined ? "" : text.trim();
      });

      const probeServerInfo = (host: string, port: number, token: string) =>
        deps.client.execute(
          HttpClientRequest.get(`http://${host}:${port}/api/server-info`).pipe(
            token ? HttpClientRequest.setHeaders({ authorization: `Bearer ${token}` }) : (request) => request,
          ),
        ).pipe(
          Effect.map((response) => response.status >= 200 && response.status < 300),
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => false),
        );

      const waitForReadyDaemon = Effect.fn("Daemon.waitForReady")(function* (): Effect.fn.Return<
        { status: ServerStatus; token: string },
        DiscoveryError | SpawnError
      > {
        const rootDir = serverRoot()!;
        const deadline = Date.now() + 30_000;
        for (;;) {
          const status = yield* readStatus(rootDir);
          const token = yield* readToken(rootDir);
          if (status !== undefined && (yield* probeServerInfo(status.host, status.port, token))) {
            return { status, token };
          }
          if (Date.now() > deadline) {
            const spawnFailure = yield* deps.spawnFailure;
            if (spawnFailure !== undefined) {
              return yield* new SpawnError({
                bin: deps.serveBin,
                message: `spawning ${deps.serveBin} serve failed: ${spawnFailure}`,
              });
            }
            return yield* new DiscoveryError({ message: "zcode serve did not report a ready daemon (30s)" });
          }
          yield* Effect.sleep(250);
          if (status !== undefined) {
            yield* log.debug(`[daemon] waiting: state=${status.state}`);
          }
        }
      });

      const connect = Effect.fn("Daemon.connect")(function* (): Effect.fn.Return<
        DaemonConnection,
        DiscoveryError | SpawnError
      > {
        const rootDir = serverRoot();
        if (rootDir === undefined) {
          return yield* new DiscoveryError({ message: "cannot resolve zcode server root (no HOME?)" });
        }
        let status = yield* readStatus(rootDir);
        const token = yield* readToken(rootDir);
        const ready = status !== undefined && (yield* probeServerInfo(status.host, status.port, token));

        if (!ready) {
          yield* deps.spawnServe();
          const found = yield* waitForReadyDaemon();
          return { status: found.status, token: found.token, wsPath: "/ws/host" } satisfies DaemonConnection;
        }

        yield* log.debug(`[daemon] attaching to ready daemon ${status!.host}:${status!.port}`);
        return { status: status!, token, wsPath: "/ws/host" } satisfies DaemonConnection;
      });

      const getCapability = Effect.fn("Daemon.getCapability")(function* (
        connection: DaemonConnection,
      ): Effect.fn.Return<string, CapabilityError> {
        const response = yield* deps.client.execute(
          HttpClientRequest.post(
            `http://${connection.status.host}:${connection.status.port}/api/rpc-host-capability`,
          ).pipe(HttpClientRequest.bearerToken(connection.token)),
        ).pipe(
          Effect.mapError(
            (cause) => new CapabilityError({ message: `capability request failed: ${formatCause(cause)}` }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new CapabilityError({
            status: response.status,
            message: `zcode server refused the host grant (HTTP ${response.status})`,
          });
        }
        const body = yield* response.json.pipe(
          Effect.mapError(
            (cause) => new CapabilityError({ message: `capability response unreadable: ${formatCause(cause)}` }),
          ),
        );
        const capability = rec(body)?.["capability"];
        if (typeof capability !== "string" || capability === "") {
          return yield* new CapabilityError({ message: "zcode server capability response missing capability" });
        }
        return capability;
      });

      return Daemon.of({ connect, getCapability });
    }),
  ).pipe(Layer.provide(DaemonDeps.layer));
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const formatCause = (cause: unknown): string => (renderError(cause));

export function dataRoot(): string {
  if (process.env.ZCODE_DATA_BASE_DIR) return process.env.ZCODE_DATA_BASE_DIR;
  return process.env.HOME ?? os.homedir();
}

export function serverRoot(): string | undefined {
  if (process.env.ZCODE_SERVER_ROOT) return process.env.ZCODE_SERVER_ROOT;
  const root = dataRoot();
  return root === undefined ? undefined : path.join(root, ".zcode", "server");
}

export function resolveServeBinary(): string {
  if (process.env.ZCODE_SERVE_BIN) return process.env.ZCODE_SERVE_BIN;
  const candidates = [
    path.join(os.homedir(), ".zcode", "server", "bin", "zcode"),
    "/usr/local/bin/zcode",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return "zcode"; // last resort: hope PATH has it
}

/**
 * Internal deps. The detached spawn is deliberately raw `node:child_process`:
 * the platform ChildProcessSpawner binds the child's lifetime to a Scope,
 * while the daemon must outlive the bridge (unref'd).
 */

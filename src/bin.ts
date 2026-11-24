#!/usr/bin/env bun
/**
 * zcode-serve-acp — ACP over stdio. Attach a coding-agent client (t3code
 * Local ACP command) to the `zcode serve` daemon. The daemon owns ZCode
 * credentials; this process never reads them.
 *
 * Wire: newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only
 * (ZCODE_SERVE_ACP_DEBUG=1 for verbose; ZCODE_SERVE_ACP_DUMP=1 dumps the
 * first conversation frame). BunRuntime.runMain installs SIGINT/SIGTERM and
 * interrupts running fibers — the pre-rewrite bridge had no signal handling.
 */
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as BunStdio from "@effect/platform-bun/BunStdio"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Stdio } from "effect/Stdio"
import { FileSystem } from "effect/FileSystem"
import type { PlatformError } from "effect/PlatformError"
import { AcpServer } from "./acp/server.ts"
import { makeTransport, runInboundLoop } from "./acp/transport.ts"
import { notification } from "./jsonrpc.ts"
import { Log } from "./log.ts"
import { fallbackModels } from "./models.ts"
import { BridgeExit } from "./serve/bridge.ts"
import { Daemon } from "./serve/daemon.ts"
import { SessionRecovery } from "./serve/recovery.ts"
import { ServeSessionFactory } from "./serve/session.ts"
import { BunSqlite } from "./serve/sqlite-bun.ts"

const CLIENT_REQUEST_TIMEOUT_MS = 600_000

const PlatformLayer = Layer.mergeAll(
  Log.layerFromEnv,
  FetchHttpClient.layer,
  BunFileSystem.layer,
  BunSocket.layerWebSocketConstructor,
  BunStdio.layer,
  BunSqlite.layer
)

const Main = Effect.gen(function* () {
  const stdio = yield* Stdio
  const sessions = yield* ServeSessionFactory
  const log = yield* Log
  const fs = yield* FileSystem
  const recovery = yield* SessionRecovery

  // One serialized writer for every outbound frame, plus the pending map for
  // client→server requests we send (permission/elicitation asks).
  const transport = makeTransport({
    write: (line) => Stream.fromIterable([line]).pipe(Stream.run(stdio.stdout())),
    log,
    timeoutMs: CLIENT_REQUEST_TIMEOUT_MS
  })

  const acp = AcpServer.make({
    sessions,
    log,
    recovery,
    emitNotification: (method, params) => transport.writeLine(notification(method, params)),
    clientRequest: transport.clientRequest,
    fallbackModels: fallbackModels.pipe(Effect.provideService(FileSystem, fs))
  })

  // Concurrent per-line dispatch: a Turn in flight must not block
  // `session/cancel` or the Client's answer to a permission ask (transport.ts).
  yield* runInboundLoop({ stdin: stdio.stdin, transport, log, handle: acp.handle })
})

const AppLayer = Layer.mergeAll(ServeSessionFactory.layerNoDeps, SessionRecovery.layerNoDeps).pipe(
  Layer.provide(Daemon.layer),
  Layer.provide(BridgeExit.layer),
  Layer.provide(PlatformLayer)
)

const program: Effect.Effect<void, PlatformError, never> = Effect.provide(
  Main,
  Layer.merge(AppLayer, PlatformLayer) as Layer.Layer<Stdio | ServeSessionFactory | Log | FileSystem | SessionRecovery>
)

BunRuntime.runMain(program)

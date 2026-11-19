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
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import { Effect, Layer, Deferred, Result, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Stdio } from "effect/Stdio";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { AcpServer } from "./acp/server.ts";
import { ClientRequestError } from "./errors.ts";
import {
  errorPayload,
  encodeLine,
  errorResponse,
  clientRequest,
  notification,
  parseLine,
  successResponse,
} from "./jsonrpc.ts";
import { Log } from "./log.ts";
import { fallbackModels } from "./models.ts";
import { Daemon } from "./serve/daemon.ts";
import { ServeSessionFactory } from "./serve/session.ts";

const CLIENT_REQUEST_TIMEOUT_MS = 600_000;

const PlatformLayer = Layer.mergeAll(
  Log.layerFromEnv,
  FetchHttpClient.layer,
  BunFileSystem.layer,
  BunSocket.layerWebSocketConstructor,
  BunStdio.layer,
);

const Main = Effect.gen(function* () {
  const stdio = yield* Stdio;
  const sessions = yield* ServeSessionFactory;
  const log = yield* Log;
  const fs = yield* FileSystem;

  const writeLine = (message: unknown) => Stream.fromIterable([encodeLine(message)]).pipe(Stream.run(stdio.stdout()));

  // client→server requests WE send (permission/elicitation asks): id ↔ Deferred map
  const pending = new Map<number, Deferred.Deferred<unknown, ClientRequestError>>();
  let nextRequestId = 900_000;

  const acp = AcpServer.make({
    sessions,
    log,
    emitNotification: (method, params) => writeLine(notification(method, params)),
    clientRequest: (method, params) =>
      Effect.gen(function* () {
        const id = nextRequestId++;
        yield* writeLine(clientRequest(id, method, params));
        const deferred = Deferred.makeUnsafe<unknown, ClientRequestError>();
        pending.set(id, deferred);
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: CLIENT_REQUEST_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ClientRequestError({ message: `client request ${method} timed out (client never answered)` }),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      }),
    fallbackModels: fallbackModels.pipe(Effect.provideService(FileSystem, fs)),
  });

  // Line-level failures never escape this loop: decode errors become a
  // stderr note (Malformed) or a JSON-RPC error response / warn log
  // (handle failures), per the pre-rewrite wire contract. The only channel
  // left is PlatformError from the stdin stream and stdout writes, which
  // genuinely ends the process (runMain logs it and exits non-zero).
  const handleLine = (line: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const outcome = yield* parseLine(trimmed).pipe(Effect.orElseSucceed(() => ({ _tag: "Malformed" as const })));
      if (outcome._tag === "Malformed") {
        yield* log.warn("[bin] non-JSON line on stdin (ignored)");
        return;
      }
      if (outcome._tag !== "Message") return;
      const inbound = outcome.inbound;

      // response to one of our client-side requests (permission asks)
      if (inbound._tag === "Response") {
        const numId = typeof inbound.response.id === "number" ? inbound.response.id : Number(inbound.response.id);
        const entry = pending.get(numId);
        if (entry !== undefined) {
          pending.delete(numId);
          if (inbound.response.error !== undefined) {
            Deferred.doneUnsafe(
              entry,
              Effect.fail(
                new ClientRequestError({ message: inbound.response.error.message ?? "client returned error" }),
              ),
            );
          } else {
            Deferred.doneUnsafe(entry, Effect.succeed(inbound.response.result));
          }
        }
        return;
      }

      const isRequest = inbound._tag === "Request";
      const method = inbound._tag === "Request" ? inbound.request.method : inbound.notification.method;
      const params = inbound._tag === "Request" ? inbound.request.params : inbound.notification.params;
      const id = inbound._tag === "Request" ? inbound.request.id : undefined;

      const outcomeResult = yield* acp.handle(method, params).pipe(Effect.result);
      if (!Result.isSuccess(outcomeResult)) {
        const error = outcomeResult.failure;
        if (isRequest && id !== undefined) {
          yield* writeLine(errorResponse(id, errorPayload(error.message)));
        } else {
          yield* log.warn(`[bin] notification ${method} failed: ${error.message}`);
        }
        return;
      }
      if (isRequest && id !== undefined) {
        yield* writeLine(successResponse(id, outcomeResult.success));
      }
    });

  yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(stdio.stdin)), handleLine);
});

const AppLayer = ServeSessionFactory.layerNoDeps.pipe(Layer.provide(Daemon.layer), Layer.provide(PlatformLayer));

const program: Effect.Effect<void, PlatformError, never> = Effect.provide(
  Main,
  Layer.merge(AppLayer, PlatformLayer) as Layer.Layer<Stdio | ServeSessionFactory | Log | FileSystem>,
);

BunRuntime.runMain(program);

/**
 * stderr logging service.
 *
 * stdout is the ACP wire — Effect's default logger writes to the global
 * console (stdout), so this project never uses `Effect.log*`. Everything goes
 * through this service, which writes to stderr only, gated on
 * `ZCODE_SERVE_ACP_DEBUG=1` (verbose) at layer construction.
 */
import { Context, Effect, Layer, type ReadonlyArray } from "effect";

export class Log extends Context.Service<Log, {
  /** verbose, only when ZCODE_SERVE_ACP_DEBUG=1 */
  debug: (...parts: ReadonlyArray<unknown>) => Effect.Effect<void>;
  /** always emitted on stderr */
  warn: (...parts: ReadonlyArray<unknown>) => Effect.Effect<void>;
}>()("zcode-serve-acp/Log") {
  static readonly layerVerbose: Layer.Layer<Log> = Log.makeLayer(true);

  static readonly layerQuiet: Layer.Layer<Log> = Log.makeLayer(false);

  /** Verbose iff ZCODE_SERVE_ACP_DEBUG=1 at layer build time. */
  static readonly layerFromEnv: Layer.Layer<Log> = Layer.effect(
    Log,
    Effect.sync(() => Log.makeService(process.env.ZCODE_SERVE_ACP_DEBUG === "1")),
  );

  private static makeService = (debug: boolean): Log =>
    Log.of({
      debug: (...parts) =>
        Effect.sync(() => {
          if (debug) console.error(...parts);
        }),
      warn: (...parts) =>
        Effect.sync(() => {
          console.error(...parts);
        }),
    });

  private static makeLayer = (debug: boolean): Layer.Layer<Log> =>
    Layer.succeed(Log, Log.makeService(debug));
}

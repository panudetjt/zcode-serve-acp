/**
 * stderr logging service.
 *
 * stdout is the ACP wire — Effect's default logger writes to the global
 * console (stdout), so this project never uses `Effect.log*`. Everything goes
 * through this service, which writes to stderr only, gated on
 * `ZCODE_SERVE_ACP_DEBUG=1` (verbose) at layer construction.
 */
import { Context, Effect, Layer } from "effect"

export interface LogShape {
  /** verbose, only when ZCODE_SERVE_ACP_DEBUG=1 */
  debug: (...parts: readonly unknown[]) => Effect.Effect<void>
  /** always emitted on stderr */
  warn: (...parts: readonly unknown[]) => Effect.Effect<void>
  /**
   * Same gate and sink as `debug`, for callers that run outside the runtime
   * (the frame translator folds synchronously, so it cannot yield an Effect).
   */
  debugSync: (...parts: readonly unknown[]) => void
}

export class Log extends Context.Service<Log, LogShape>()("zcode-serve-acp/Log") {
  static readonly makeService = (debug: boolean): LogShape => {
    const debugSync = (...parts: readonly unknown[]): void => {
      if (debug) console.error(...parts)
    }
    return Log.of({
      debugSync,
      debug: (...parts) => Effect.sync(() => debugSync(...parts)),
      warn: (...parts) =>
        Effect.sync(() => {
          console.error(...parts)
        })
    })
  }

  static readonly layerVerbose: Layer.Layer<Log> = Layer.succeed(Log, Log.makeService(true))

  static readonly layerQuiet: Layer.Layer<Log> = Layer.succeed(Log, Log.makeService(false))

  /** Verbose iff ZCODE_SERVE_ACP_DEBUG=1 at layer build time. */
  static readonly layerFromEnv: Layer.Layer<Log> = Layer.effect(
    Log,
    Effect.sync(() => Log.makeService(process.env.ZCODE_SERVE_ACP_DEBUG === "1"))
  )
}

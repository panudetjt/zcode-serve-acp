/**
 * Bridge lifecycle seam for the issue #5 fail-fast fallback: when the Daemon
 * is unreachable after the bounded reconnect budget, the Bridge terminates
 * ITSELF with a non-zero exit. The Client sees the process die and engages
 * its own runtime recovery (restarting the Bridge), instead of every later
 * Turn answering with a JSON-RPC -32000 error that reads as a provider
 * failure.
 *
 * Architecture contract: the daemon is NEVER killed by the bridge — this
 * exits only the Bridge process.
 */
import { Context, Effect, Layer } from "effect"
import { Log } from "../log.ts"

export class BridgeExit extends Context.Service<
  BridgeExit,
  {
    /**
     * Terminate the Bridge process with a non-zero exit code. Never returns
     * normally; the error channel is `never` because `process.exit` is total.
     */
    readonly exit: (reason: string) => Effect.Effect<never>
  }
>()("zcode-serve-acp/BridgeExit") {
  static readonly layer: Layer.Layer<BridgeExit, never, Log> = Layer.effect(
    BridgeExit,
    Effect.gen(function* () {
      const log = yield* Log
      return BridgeExit.of({
        exit: (reason) =>
          Effect.gen(function* () {
            // stderr only — stdout is the ACP wire.
            yield* log.warn(`[bridge] ${reason} — exiting so the Client can restart the Bridge`)
            return yield* Effect.sync(() => process.exit(1))
          })
      })
    })
  )
}

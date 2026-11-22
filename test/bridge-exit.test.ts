import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Log } from "../src/log.ts"
import { BridgeExit } from "../src/serve/bridge.ts"

describe("BridgeExit fail-fast layer (issue #5)", () => {
  test("exit logs the reason to stderr and terminates the Bridge with code 1", async () => {
    // The real layer ends the process — stub `process.exit` at the boundary
    // so the wiring (log → exit call → code 1) is exercised in-process.
    const exitCodes: Array<number> = []
    const originalExit = process.exit
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0)
    }) as typeof process.exit
    try {
      const program = Effect.gen(function* () {
        const bridgeExit = yield* BridgeExit
        return yield* bridgeExit.exit("zcode daemon unreachable after 2 reconnect attempts")
      }).pipe(Effect.provide(BridgeExit.layer), Effect.provide(Log.layerQuiet))
      await Effect.runPromise(program)
    } finally {
      process.exit = originalExit
    }
    expect(exitCodes).toEqual([1])
  })
})

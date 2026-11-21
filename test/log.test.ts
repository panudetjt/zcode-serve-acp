import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Log } from "../src/log.ts"

describe("Log service", () => {
  test("makeService debug and warn write to stderr", async () => {
    const origErr = console.error
    let logged: unknown[] = []
    console.error = (...args) => {
      logged.push(args)
    }
    try {
      // debug=false
      const quiet = Log.makeService(false)
      await Effect.runPromise(quiet.debug("hidden message"))
      expect(logged.length).toBe(0)
      await Effect.runPromise(quiet.warn("visible warning"))
      expect(logged.length).toBe(1)

      // debug=true
      const verbose = Log.makeService(true)
      await Effect.runPromise(verbose.debug("debug message"))
      expect(logged.length).toBe(2)

      // debugSync is the sync escape hatch for the frame translator's fold —
      // same gate and sink as debug.
      const loud = Log.makeService(true)
      loud.debugSync("sync debug line")
      expect(logged.length).toBe(3)
      Log.makeService(false).debugSync("sync, but quiet")
      expect(logged.length).toBe(3)
    } finally {
      console.error = origErr
    }
  })

  test("layers construct properly", async () => {
    const quietService = await Effect.runPromise(Log.pipe(Effect.provide(Log.layerQuiet)))
    expect(typeof quietService.debug).toBe("function")

    const verboseService = await Effect.runPromise(Log.pipe(Effect.provide(Log.layerVerbose)))
    expect(typeof verboseService.debug).toBe("function")

    const envService = await Effect.runPromise(Log.pipe(Effect.provide(Log.layerFromEnv)))
    expect(typeof envService.debug).toBe("function")
  })
})

# Effect v4 patterns for this project

Distilled from the vendored source in `repos/effect/` (read `LLMS.md` first,
and the `ai-docs/src/` examples it links). These are the idioms this codebase
uses — match them, don't invent alternatives.

## Style: `Effect.gen` and `Effect.fn`

- Inline code: `Effect.gen(function*() { ... })`, `yield*` for results.
- Reusable effect functions: `Effect.fn("Name.method")(function*(args) {...}, <combinators>)`.
  Prefer `Effect.fnUntraced` for hot paths / pure helpers that don't need a
  span. **Do not** wrap `Effect.gen` in a plain function; **do not** `.pipe`
  inside `Effect.fn` — pass combinators as extra arguments.
- Always `return yield*` (not bare `yield*`) when raising an error, so the
  generator's reachability types stay correct.

```ts
export const load = Effect.fn("Daemon.load")(function*() {
  const status = yield* readStatus
  return status
}, Effect.retry({ times: 3 }))
```

## Services: `Context.Service` + `Layer`

v4 default (from `ai-docs/src/01_effect/03_services/`):

```ts
export class Daemon extends Context.Service<Daemon, {
  attach(): Effect.Effect<Channel, DaemonError>
}>()("zcode-serve-acp/Daemon") {
  static readonly layerNoDeps = Layer.effect(Daemon, Effect.gen(function*() {
    const fs = yield* /* other services */ ...
    const attach = Effect.fn("Daemon.attach")(function*() { ... })
    return Daemon.of({ attach })
  }))
  // layerNoDeps declares R in its Layer type; `layer` provides the deps:
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(Fs.layer))
}
```

- Name the service tag `"zcode-serve-acp/<Name>"`.
- Construct implementations with `Service.of({...})`.
- Access the plain interface type with `Daemon["Service"]` if needed.
- One service per file, layer as a static member. Compose with
  `Layer.provide` / `Layer.provideMerge`; build the final app layer in `bin.ts`
  and run with `BunRuntime.runMain(Layer.launch(app))` (or `Effect.runPromise`
  where a ManagedRuntime is simpler).
- **Zero-arg operations are Effect values, not methods.** An `Effect` is already
  lazy, so a zero-arg method that only returns one adds indirection and trips
  the `lazy-effect` diagnostic. Expose the value instead: `readonly dispose:
  Effect.Effect<void>`, `readonly connect: Effect.Effect<DaemonConnection,
  DiscoveryError | SpawnError>`, and call it as `yield* service.dispose`. When
  the body must be rebuilt per run (a `Effect.fn` span, fresh discovery), wrap
  the callable with `Effect.suspend(Effect.fn("Name.op")(function*() {...}))` —
  `Effect.suspend` invokes the callable on every run, so each run gets a fresh
  span and generator, exactly like the old call-per-use method.

## Errors: `Schema.TaggedError` + `catchTag`

Every error crossing a module boundary is a tagged error:

```ts
export class DecodeError extends Schema.TaggedError<DecodeError>()("DecodeError", {
  location: Schema.String,
  cause: Schema.Defect()
}) {}
```

- Catch specific errors with `Effect.catchTag("DecodeError", ...)` or many at
  once with `Effect.catchTags({...})`; fallback with `Effect.catch`.
- Wrap promise/callback APIs with `Effect.tryPromise({ try, catch })` /
  `Effect.try({ try, catch })` — `catch` maps to a tagged error, never a bare
  string.
- Keep the error channel precise: it is the rewrite's replacement for the old
  "throw generic Error + hardcoded JSON-RPC -32000".
- Callbacks that cross a module boundary carry their failure channel as a type
  parameter (channel.ts `ChannelHandlers<E>` → session.ts `SessionHandlers<E>`),
  so the app's concrete errors flow down from the entry point without widening
  to `unknown` and without a cast. `tolerate` takes the same second parameter
  (`E2`) and absorbs it, so a best-effort wrapper is `never`-failing by
  construction.

## Schema at every JSON boundary

- Decode unknown data with `Schema.decodeUnknownEffect(schema)` (typed error
  in the channel), encode with `Schema.encodeEffect`. Build decoders once at
  module scope, not per call.
- Domain models that must only exist validly: `Schema.Class<Name>("Path/Name")({...})`.
- Wire messages whose shape varies: unions of `Schema.TaggedStruct` /
  `Schema.Union`, never manual `as Record<string, unknown>` narrowing.
- Unknown-but-tolerated extra fields: prefer `Schema.Struct` with explicit
  fields plus `onExcessProperty: "ignore"` at the boundary where the daemon
  sends more than we model.
- The binary wire codec is the ONE exception: hand-rolled parser returning
  `Result`/raising `DecodeError` — do not force it through Schema.

## Resources and lifecycle

- Wrap callback APIs (WebSocket, child process, readline) with
  `Effect.acquireRelease(acquire, release)` inside a `Scope` — the release
  always runs, replacing the old manual `clearTimeout`/`close` bookkeeping.
- Long-lived app-level resources belong in `Layer.effect` acquire/release.
- Timers: `Effect.timeout(duration)` on the racing effect, `Effect.sleep` for
  delays (quiet-timer pattern → `Effect.race` of turn completion and quiet
  windows instead of `setTimeout` + flags).

## Streams

- Callback-based event sources (WS messages, daemon events):
  `Stream.callback<A, E, R>(Effect.fn(function*(queue) { yield* Effect.acquireRelease(register, unregister) }))`
  with `Queue.offerUnsafe(queue, value)` from the raw callbacks.
- Stateful per-event translation: `Stream.mapAccum` / `Stream.mapAccumEffect`
  over the frame stream (this replaces the old mutable `FrameTranslator.fold`).
- Consume with `Stream.runForEach` / `Stream.run` into a scoped fiber.
- Convert async iterables (stdin lines): `Stream.fromAsyncIterable(iterable, onError)`.

## Coordination primitives

- One-shot completion (turn ended, RPC answered): `Deferred.make` →
  `Deferred.succeed` / `Deferred.fail` → `Deferred.await` with
  `Effect.timeout`. This replaces all three hand-rolled pending-promise maps.
- Many-consumer events: `PubSub`; single-consumer queues: `Queue`.
- Concurrency limits: `Semaphore.make`.

## Testing

- `bun:test` (`describe`/`it`/`expect`), run effects with
  `Effect.runPromise(effect.pipe(Effect.provide(TestLayer)))`.
- Deterministic time: `effect/testing/TestClock` (`TestClock.layer`, then
  `TestClock.adjust("5 seconds")`).
- Services are injected — tests build a test `Layer` with fake
  `Daemon`/`Channel`, never stub private fields.
- Golden replay: feed `test/fixtures/golden-frames/*.json` frames through the
  current translator and compare with the recorded pre-rewrite output.

## Platform services (Bun runtime, portable abstractions)

Runtime deps are `effect` + `@effect/platform-bun`. Bun builtins are reached
**through platform services only**, never imported directly in domain code —
that is the whole point: swapping runtime later means swapping layers.

- **WebSocket**: `Socket.makeWebSocket(url, { headers, openTimeout })` from
  `effect/socket/Socket` (headers are a first-class option here — no more
  `as never` casts), provided by
  `BunSocket.layerWebSocketConstructor` from `@effect/platform-bun/BunSocket`.
- **HTTP**: `HttpClient.HttpClient` service from `effect/http`
  (`HttpClient.mapRequest` + `HttpClientRequest`, `HttpClient.filterStatusOk`)
  provided by `BunHttpClient.layer`.
- **Child processes**: `ChildProcessSpawner` from `effect/process` provided by
  `BunChildProcessSpawner.layer` (it already handles spawn `error` events —
  the pre-rewrite 30 s-late-failure bug is gone by construction).
- **Files**: `FileSystem.FileSystem` service provided by `BunFileSystem.layer`.
- **stdin/stdout**: `Stdio` service provided by `BunStdio.layer`.
- **Entry point**: `BunRuntime.runMain(program)` — installs SIGINT/SIGTERM and
  interrupts fibers for graceful shutdown (the old bridge had no signal
  handling at all).
- In tests, all of the above are fake-able: tests provide in-memory
  `Layer` implementations of the same service interfaces.

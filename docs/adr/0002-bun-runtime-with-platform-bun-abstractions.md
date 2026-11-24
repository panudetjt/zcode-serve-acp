# Bun runtime, reached through @effect/platform-bun abstractions

The bridge compiles to a single binary with `bun build --compile` and runs on
Bun only (pinned via mise). Bun builtins (WebSocket, child_process, stdin,
fs, HTTP) are reached only through platform services —
`BunSocket.layerWebSocketConstructor`, `BunFileSystem.layer`,
`BunStdio.layer`, core `FetchHttpClient` (which uses the runtime's global
fetch) — never imported directly in domain code. Swapping runtimes later then
means swapping layers (e.g. `@effect/platform-node`), not rewriting services.

Two deliberate deviations:

1. The detached `zcode serve` spawn uses raw `node:child_process` with
   `detached: true` + `unref()`: the platform `ChildProcessSpawner` binds the
   child's lifetime to a Scope, while the daemon must deliberately outlive
   the bridge.
2. The binary wire codec (`src/serve/wire.ts`) is hand-rolled, not expressed
   in `Schema`: its 13-byte frame header and VQL varints are
   reverse-engineered daemon internals where per-field probes are the spec
   (golden fixtures encode the outcomes). Schema covers all JSON boundaries.

`@effect/platform-bun` 4.1.4 ships no SQLite service. The orphan tool-part heal
(issue #21) has to close rows in the Daemon's own SQLite store, so the bridge
defines that port itself — `Sqlite` in `src/serve/sqlite.ts` — and keeps the
one `bun:sqlite` import in its Bun driver, `src/serve/sqlite-bun.ts`, provided
by `bin.ts` next to the package layers. Same rule as above; the port is simply
one of our own.

Rejected: `effect` core only (no platform package) — cheaper compile, but
runtime-portable abstractions were chosen instead (Q4b, 2026-11-19); and
Node.js as primary target — single-binary Bun compile is the distribution
model (109 MB binary, gitignored).

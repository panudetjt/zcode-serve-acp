# AGENTS.md

Instructions for coding agents working in this repository.

## What this project is

`zcode-serve-acp` is a standalone Agent Client Protocol (ACP) bridge binary. It
sits between an ACP-speaking client over stdio (T3 Code's "Local ACP command")
and the `zcode serve` daemon, so the daemon alone owns credentials. It is
written in TypeScript, runs on **Bun only**, and compiles to a single binary
with `bun build --compile`. It is being rewritten on the `rewrite/effect4`
branch to use **Effect v4** (`effect` + `@effect/platform-bun`, full
idiomatic services — the platform abstractions keep runtime-portable behavior
if the runtime ever changes).

Domain vocabulary lives in [GLOSSARY.md](./GLOSSARY.md) — use those terms
(Bridge, Daemon, Channel, Conversation frame, Turn, Pending interaction, …)
consistently in code, comments, and commit messages.

## Vendored Effect source — read-only reference

`repos/effect/` is the Effect-TS/effect monorepo vendored via
`git subtree add --prefix=repos/effect --squash`. It exists so you can read
real source instead of guessing from docs or web search.

**Rules:**

1. **Never edit anything under `repos/`** — it is vendored reference material.
2. **Never import from `repos/`** in project code. Dependencies come from the
   npm registry (`bun add`).
3. **Before writing or reviewing Effect code, read
   [`repos/effect/LLMS.md`](./repos/effect/LLMS.md)**, then inspect the
   referenced sources under `repos/effect/ai-docs/src/` and
   `repos/effect/packages/effect/src/` for the exact v4 API shapes. Prefer
   these over your memory of Effect v3 or any web search result.
4. **Prefer the distilled patterns** in
   [`agent-patterns/effect.md`](./agent-patterns/effect.md) — they are
   extracted from this vendored source and match the idioms this project uses.

**Updating the vendored copy** (rare, do only when asked):

```sh
git subtree pull --prefix=repos/effect --squash https://github.com/Effect-TS/effect.git main
```

Each update lands as exactly one reviewable commit. Keep everything under
`repos/` and always pass `--squash`.

## Commands

| Task | Command |
|---|---|
| Unit tests (with coverage) | `mise run test` (= `bun test --coverage ./test`) |
| Typecheck | `mise run check` (= `bun check`) |
| Compile single binary | `mise run compile` |
| E2E smoke (needs a real local daemon) | `mise run smoke` |
| All tasks | `mise run ci` |
| Format | `mise run fmt` |
| Lint | `mise run lint` |

Bun version is pinned via `mise.toml` (1.4.4).

## Architecture contracts (do not break)

- **Drop-in replacement**: binary name `zcode-serve-acp`, the four env vars
  (`ZCODE_SERVE_BIN`, `ZCODE_SERVE_ACP_DEBUG`, `ZCODE_DATA_BASE_DIR`,
  `ZCODE_SERVER_ROOT`), and the ACP surface must stay identical to the
  pre-rewrite bridge, so existing client configs keep working.
- **The daemon is never killed** by the bridge; the bridge never reads or
  decrypts credentials (token *presence* checks are allowed, decryption is
  not).
- Protocol knowledge is reverse-engineered from `server-core.js` (runtime
  3.18.2) and recorded in provenance comments. Keep those comments when you
  move code; they are the only protocol documentation.
- Wire codec (`src/serve/wire.ts`) is intentionally hand-rolled (13-byte frame
  header, VQL varints) — do not try to express it in `Schema`. JSON boundaries
  (daemon frames, RPC results, ACP messages, config files) all go through
  `Schema`.
- Bun builtins are reached only through platform services (`FileSystem`,
  `HttpClient`, `ChildProcessSpawner`, `Stdio`, `Socket`/`WebSocketConstructor`),
  never imported directly in domain code — see
  [agent-patterns/effect.md](./agent-patterns/effect.md).

## Tests

- Framework is `bun:test`. Do not introduce vitest.
- Tests exercise public APIs and injected service layers; they do not reach
  into private fields via `as unknown as` casts (a pre-rewrite anti-pattern
  that was removed on purpose).
- `test/fixtures/golden-frames/` holds conversation frames captured from a
  real daemon. The replay test compares the current FrameTranslator's output
  against the recorded pre-rewrite translator output — **this is the parity
  gate for the rewrite**. Do not edit fixtures by hand; regenerate with
  `scripts/capture-frames.ts` against a live daemon (see its header comment
  for the required scenarios and sanitization rules).
- `scripts/smoke.mjs` and the `probe-*.mjs` scripts run against a real daemon;
  they are not part of CI.

## Repo hygiene

- `dist/` and `node_modules/` are gitignored; never commit binaries.
- The prebuilt binary at `dist/zcode-serve-acp` is only produced by
  `mise run compile`, never checked in.

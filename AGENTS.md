# AGENTS.md

Instructions for coding agents working in this repository.

## What this project is

`zcode-serve-acp` is a standalone Agent Client Protocol (ACP) bridge binary. It
sits between an ACP-speaking client over stdio (T3 Code's "Local ACP command")
and the `zcode serve` daemon, so the daemon alone owns credentials. It is
written in TypeScript, runs on **Bun only**, and compiles to a single binary
with `bun build --compile`. It runs on **Effect v4** (`effect` +
`@effect/platform-bun`, full idiomatic services — the platform abstractions
keep runtime-portable behavior if the runtime ever changes; merged from
`rewrite/effect4` in PR #1).

Domain vocabulary lives in [GLOSSARY.md](./GLOSSARY.md) — use those terms
(Bridge, Daemon, Channel, Conversation frame, Turn, Pending interaction, …)
consistently in code, comments, and commit messages.

## Effect reference clone — read-only, gitignored

`.repos/effect/` is a gitignored local clone of the Effect-TS/effect monorepo
(reference material only — never committed, never built). It exists so you can
read real source instead of guessing from docs or web search. If it is missing,
create it on demand:

```sh
mkdir -p .repos && git clone --depth 1 https://github.com/Effect-TS/effect.git .repos/effect
```

**Rules:**

1. **Never edit anything under `.repos/`** — it is read-only reference material.
2. **Never import from `.repos/`** in project code. Dependencies come from the
   npm registry (`bun add`).
3. **Before writing or reviewing Effect code, read
   [`.repos/effect/LLMS.md`](./.repos/effect/LLMS.md)**, then inspect the
   referenced sources under `.repos/effect/ai-docs/src/` and
   `.repos/effect/packages/effect/src/` for the exact v4 API shapes. Prefer
   these over your memory of Effect v3 or any web search result.
4. **Prefer the distilled patterns** in
   [`agent-patterns/effect.md`](./agent-patterns/effect.md) — they are
   extracted from this vendored source and match the idioms this project uses.

**Updating the clone** (rare, do only when asked): `git -C .repos/effect pull`.
The clone tracks upstream `main`, which can run ahead of the npm release —
when the two disagree, the installed npm package (`effect` 4.1.4) is ground
truth for what compiles (see docs/adr/0001).

## T3 Code reference clone — read-only, gitignored

`.repos/t3code/` is a gitignored local clone of the T3 Code client
(pingdotgg/t3code) — the ACP client on the other side of this bridge. Same
rules as the effect clone: read-only, never committed, never imported. It
exists so the client side of the protocol (what T3 does with our
`session/update` output, and what a native per-agent shim must look like) is
checked against real source, not memory. If it is missing, create it on
demand:

```sh
mkdir -p .repos && git clone --depth 1 https://github.com/pingdotgg/t3code.git .repos/t3code
```

**Before touching anything subagent/T3-client related, read
[`agent-patterns/t3code.md`](./agent-patterns/t3code.md)** — the distilled
facts (adapter-v2 subagent hooks, `_t3_unknown` channel, per-agent shim
layout) extracted from `.repos/t3code/packages/provider-acp-registry/src/server/claudeAcp.ts`
and `packages/provider-acp/src/server/adapter.ts` — and, for the Client side
of the contract (process lifecycle, timeouts, wire rules), read
[`agent-patterns/t3code-client-contract.md`](./agent-patterns/t3code-client-contract.md).

**Updating the clone** (rare, do only when asked): `git -C .repos/t3code pull`.

## Commands

| Task | Command |
|---|---|
| Unit tests (with coverage) | `mise run test` (= `bun test --coverage ./test`) |
| Typecheck | `mise run check` (= `bun check`) |
| Compile single binary | `mise run compile` |
| Binary install / backup / restore | `scripts/install.sh` (flags: `--help`) |
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
  3.18.2, re-verified unchanged against 3.19.0 via the endpoint/constant diff
  and `scripts/probe-tools-load.mjs`) and recorded in provenance comments.
  Keep those comments when you move code; they are the only protocol
  documentation.
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
- `test/install-script.test.ts` exercises `scripts/install.sh` (install /
  restore / list dispatch, restore selection, process cutover, `--bin`
  validation) against temp dirs — no build and no daemon involved.

## Repo hygiene

- `dist/`, `node_modules/`, and `.repos/` are gitignored; never commit binaries or reference clones.
- The prebuilt binary at `dist/zcode-serve-acp` is only produced by
  `mise run compile`, never checked in.

## Effect Devtools (installed)

- `@effect/tsgo` + `oxlint-tsgolint` + `typescript` 7 are devDependencies; `bun install`
  runs `effect-tsgo patch --oxlint` (patches the oxlint native binding, its `.d.ts`
  type augmentation for `oxlint.config.ts`, and tsgolint). Don't remove the prepare
  script — the Effect lint rules need the patch after every fresh install.
- `oxlint.config.ts` extends `@effect/tsgo/oxlint-presets/recommended` — the 154 Effect
  diagnostics run type-aware through the patched tsgolint. `mise run lint` is the gate.
- `tsconfig.json` plugins entry enables the LSP in editors that use the workspace
  TypeScript version (VS Code/Cursor: status-bar TS version → "Use Workspace Version").
  `diagnostics: false` per the Devtools docs so diagnostics come from Oxlint only;
  `allowedUnstableApis` lists the platform surfaces this project deliberately uses
  (ADR 0002). The VS Code/Cursor debugger extension (`effectful-tech.effect-vscode`)
  adds fiber/context/span-stack inspection — install it in the editor, not the repo.

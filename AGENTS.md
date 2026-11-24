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

## ZCode reference clone — read-only, gitignored

`.repos/zcode/` is a gitignored local clone of the ZCode source repository
(`zai-org/ZCode`). Same rules as the effect and t3code clones: read-only,
never committed, never imported. It exists so the daemon and `server-core`
protocol internals (e.g. `packages/zcode-server-cli/src/server-core`,
`apps/zcode-cli`) can be cross-referenced against original TypeScript source
instead of relying solely on minified/bundled `server-core.js` or reverse
engineering. If it is missing, create it on demand:

```sh
mkdir -p .repos && git clone --depth 1 https://github.com/zai-org/ZCode.git .repos/zcode
```

**Updating the clone** (rare, do only when asked): `git -C .repos/zcode pull`.

## T3 toolset naming at runtime — agents, read before answering "do I have the toolset?"

Sessions running under this Bridge receive T3 Code's toolsets (orchestration,
PR/issue, preview, device, secrets, …) as MCP tools named
**`mcp__t3-code__<shortName>`** — e.g. `mcp__t3-code__delegate_task`,
`mcp__t3-code__t3_thread_launch`, `mcp__t3-code__pull_request_read`,
`mcp__t3-code__html_render`. The `<t3_code_instructions>` block in the system
prompt references those tools by the **bare short names, without the
`mcp__t3-code__` prefix** (the same block ships to native providers whose tool
names really are bare).

Consequences for every session in this repo:

- To **call** a tool the instructions name bare, prefix it:
  `delegate_task` → `mcp__t3-code__delegate_task`. Do not report a call as
  impossible because the bare name is not in the function list.
- To **check presence**, search the function list for the `mcp__t3-code__`
  prefix. Bare-name absence is NOT evidence the toolset is missing. The chain
  T3 → Bridge (`session/new` + stdio `mcpServers`, PR #14) → Daemon (spawns
  the `t3-code` MCP server) works; verified live via daemon log
  `mcp.server.connected t3-code` (`~/.zcode/cli/log/zcode-*.jsonl`).
- Shell env vars (`T3_ACP_MCP_NODE`, `T3CODE_THREAD_ID`) are NOT a reliable
  signal either way: the client merges them into the Bridge spawn env from a
  spawn-time context, while the MCP servers are re-read per runtime start
  (`session/new`) — the two can diverge. Judge presence by the function
  list, not by env.
- A toolset that is really gone is a Bridge matter, not a Client one: the
  daemon keeps a session's MCP servers only in the runtime a Turn runs on,
  and remakes that runtime without them, so the Bridge puts them back before
  a Turn that would run without them (issue #26, `ensureMcpServers` in
  `src/serve/session.ts`). Its `[mcp]` log lines say when it did.
- Repo docs only cover sessions in THIS repo. The installer ships the same
  note machine-wide: `scripts/install.sh --global-agents` writes a managed
  block into `~/.zcode/AGENTS.md` (the daemon's global instructions file,
  injected into every fresh session — verified live with a marker probe)
  carrying the combined T3 toolset note — prefix naming, browser entry
  points `preview_status`/`preview_open`/`preview_snapshot`/`preview_act`,
  and the scan-the-function-list gate before any "tool X is unavailable"
  claim (lean per the 2026-11-22 audit: no incident narration, no dated
  counts); `--remove-global-agents` strips it. A pre-managed hand-added copy
  of the superseded browser note is stripped on install and on removal, so
  hand-pasted duplicates never accumulate. The daemon always wraps MCP tools
  as `mcp__<server>__<tool>`, so a Bridge-side rename to the bare
  instruction names is impossible — the note, not a rename, is the fix.

## Commands

| Task | Command |
|---|---|
| Unit tests (with coverage) | `mise run test` (= `bun test --coverage ./test`) |
| Typecheck | `mise run check` (= `bun check`) |
| Compile single binary | `mise run compile` |
| Binary install / backup / restore | `scripts/install.sh` (flags: `--help`) |
| E2E smoke (needs a real local daemon) | `mise run smoke` |
| Release (bump + changelog + tag + draft GH release; the release CI — tag-push trigger in `.github/workflows/release.yml` — then gates, cross-compiles the release targets from the tag (linux-x64 for now), and attaches binaries + `SHA256SUMS` to the draft; maintainer-run, `--dry-run` previews) | `mise run release` |
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
- Two things the bridge does beyond driving Turns, recorded here because they
  reach past the ACP surface: it may ask the Daemon to restart **one
  session's runtime** — never the Daemon itself — either to unwedge that
  session (`ServeSession.restartRuntime`) or, before a Turn, because the
  runtime the session has was made without the Client's MCP servers
  (`ensureMcpServers`, issue #26: the daemon reads them only as it creates a
  runtime). Both resume the runtime with `session/resume` carrying the
  Client's MCP servers; a live runtime is stopped first with
  `session/lifecycle/stop` because a resume leaves it as it is, and
  `ensureMcpServers` skips the stop when the runtime is already gone. And it
  closes open tool parts in the Daemon's conversation store
  (`SessionRecovery`, the only writer of that store outside the Daemon).
- Protocol knowledge is reverse-engineered from `server-core.js` (runtime
  3.18.2, re-verified unchanged against 3.19.0 via the endpoint/constant diff
  and `scripts/probe-tools-load.mjs`) and recorded in provenance comments.
  Keep those comments when you move code; they are the only protocol
  documentation.
- Wire codec (`src/serve/wire.ts`) is intentionally hand-rolled (13-byte frame
  header, VQL varints) — do not try to express it in `Schema`. JSON boundaries
  (daemon frames, RPC results, ACP messages, config files, daemon store rows)
  all go through `Schema`.
- Bun builtins are reached only through platform services (`FileSystem`,
  `HttpClient`, `ChildProcessSpawner`, `Stdio`, `Socket`/`WebSocketConstructor`),
  never imported directly in domain code — see
  [agent-patterns/effect.md](./agent-patterns/effect.md). `Sqlite` is the
  bridge's own such port (`src/serve/sqlite.ts`; Bun driver
  `src/serve/sqlite-bun.ts`, provided by `bin.ts`) because
  `@effect/platform-bun` ships none.

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

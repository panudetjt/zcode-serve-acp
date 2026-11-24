# zcode-serve-acp

Standalone **Agent Client Protocol (ACP) bridge** that attaches a coding-agent client (e.g. **T3 Code → Local ACP command**) to the **`zcode serve` daemon** — the ZCode CLI's own server.

Why: the community bridge (`zcode-acp-server`) reads the CLI's credential store from outside and dies on `enc:v2:env:`-encrypted stores (headless/WSL server CLI). This bridge takes a different door — the daemon **owns all credentials itself** (the CLI reads its own store, signs its own requests), so the bridge never touches secrets, and the **model picker advertises the daemon's own models** (`session/create` → `settings.model.available`).

Derived from the owner's closed t3code PRs #33684/#34713 (`pingdotgg/t3code`) — protocol reverse-engineered and ground-truthed against `server-core.js` runtime 3.18.2, re-verified against 3.19.0 (endpoint/constant diff + `scripts/probe-tools-load.mjs`).

## Build (single binary)

```bash
mise run compile      # → dist/zcode-serve-acp (OUTFILE=… overrides the target)
mise run test         # codec + install-script tests
mise run smoke        # ACP handshake + session/new + real prompt vs the daemon
scripts/install.sh    # build + backup + atomic install/restore (flags: --help)
bun scripts/probe-tools-load.mjs --bin dist/zcode-serve-acp   # tool-call + load probe
```

## Releases

`mise run release` bumps the version, tags `vX.Y.Z`, and opens a **draft** GitHub release with the changelog section. The release CI ([.github/workflows/release.yml](.github/workflows/release.yml), tag-push trigger) then runs the full gates, cross-compiles the binary from the tag, and attaches the assets to the draft — `linux-x64` for now (the target used here; more targets live in `BUN_TARGETS` in scripts/release.ts when needed) plus `SHA256SUMS`. Review the draft on GitHub and publish.

Re-attach assets for an existing tag: Actions → Release → Run workflow, picking the tag.

## Use in T3 Code

Settings → Providers → Add provider → Show more → **Local ACP command**:

- Executable: `/home/<you>/work/zcode-serve-acp/dist/zcode-serve-acp`
- Arguments: none. Environment: none required.

The bridge discovers the daemon (`~/.zcode/server/run/status.json` → probe `/api/server-info` → `ingress-token` → `POST /api/rpc-host-capability`), spawns `zcode serve` detached if no ready daemon, and attaches over the binary WS channel (`/ws/host` + `x-zcode-rpc-host-capability`). It never kills the daemon.

T3 Code's own toolsets reach the model end-to-end: the client sends its
session-scoped MCP server in `session/new`, the bridge forwards it to the
daemon (MCP integration, PR #14), and the daemon attaches it as a stdio MCP
server named `t3-code` — so tools surface to agents as
`mcp__t3-code__<name>` (e.g. `mcp__t3-code__delegate_task`). The T3
instructions block references those tools by bare names; agents should treat
bare name + `mcp__t3-code__` prefix as the same tool.

The bridge keeps those servers in the session's runtime and puts them back
before any Turn that would otherwise run without them, so the toolset
survives a daemon restart or an idle-session unload. The mechanism is in
[AGENTS.md](./AGENTS.md) under "Architecture contracts".

For agents in **any** project (not just this repo), the installer ships the
combined toolset note into the daemon's global instructions file — the
daemon injects `~/.zcode/AGENTS.md` into every fresh session (verified live):

```sh
scripts/install.sh --global-agents      # add / refresh the managed note
scripts/install.sh --remove-global-agents   # strip it again
```

The daemon always wraps MCP tools as `mcp__<server>__<tool>`, so the bridge
cannot rename them to the bare instruction names — the note, not a rename,
is the fix. A pre-managed hand-added copy of the superseded browser note is
stripped on both install and removal, so hand-pasted duplicates never
accumulate.

## Requirements

- ZCode CLI ≥ 0.17.1 with server runtime (`~/.zcode/server/bin/zcode`) and `zcode login` done once
- Bun ≥ 1.4 to build (the binary embeds the runtime — clients need nothing)
- **Linux x64** for `scripts/install.sh` (GNU coreutils + `/proc`, matching the linux-x64 build); backups land in `dist/backups/` at roughly binary size each and are not pruned automatically

## MVP surface

initialize · session/new (models from daemon) · session/prompt (streaming `session/update`: message/thought chunks, tool calls) · permission requests mapped to `session/request_permission` · `session/set_mode` · `session/set_model` · `session/cancel`. Phase 2: resume/loadSession, compact, fork.

## Env knobs

- `ZCODE_SERVE_BIN` — zcode launcher override (default: `~/.zcode/server/bin/zcode`, then PATH)
- `ZCODE_SERVE_ACP_DEBUG=1` — verbose logs on stderr
- `ZCODE_SERVE_ACP_DUMP=1` — dump first conversation frames (protocol debugging)

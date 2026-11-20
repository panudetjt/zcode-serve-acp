# zcode-serve-acp

Standalone **Agent Client Protocol (ACP) bridge** that attaches a coding-agent client (e.g. **T3 Code → Local ACP command**) to the **`zcode serve` daemon** — the ZCode CLI's own server.

Why: the community bridge (`zcode-acp-server`) reads the CLI's credential store from outside and dies on `enc:v2:env:`-encrypted stores (headless/WSL server CLI). This bridge takes a different door — the daemon **owns all credentials itself** (the CLI reads its own store, signs its own requests), so the bridge never touches secrets, and the **model picker advertises the daemon's own models** (`session/create` → `settings.model.available`).

Derived from the owner's closed t3code PRs #33684/#34713 (`pingdotgg/t3code`) — protocol reverse-engineered and ground-truthed against `server-core.js` runtime 3.18.2, re-verified against 3.19.0 (endpoint/constant diff + `scripts/probe-tools-resume.mjs`).

## Build (single binary)

```bash
mise run compile      # → dist/zcode-serve-acp (OUTFILE=… overrides the target)
mise run test         # codec + install-script tests
mise run smoke        # ACP handshake + session/new + real prompt vs the daemon
scripts/install.sh    # build + backup + atomic install/restore (flags: --help)
bun scripts/probe-tools-resume.mjs   # tool-call + session/load resume probe
```

## Use in T3 Code

Settings → Providers → Add provider → Show more → **Local ACP command**:

- Executable: `/home/<you>/work/zcode-serve-acp/dist/zcode-serve-acp`
- Arguments: none. Environment: none required.

The bridge discovers the daemon (`~/.zcode/server/run/status.json` → probe `/api/server-info` → `ingress-token` → `POST /api/rpc-host-capability`), spawns `zcode serve` detached if no ready daemon, and attaches over the binary WS channel (`/ws/host` + `x-zcode-rpc-host-capability`). It never kills the daemon.

## Requirements

- ZCode CLI ≥ 0.17.1 with server runtime (`~/.zcode/server/bin/zcode`) and `zcode login` done once
- Bun ≥ 1.4 to build (the binary embeds the runtime — clients need nothing)

## MVP surface

initialize · session/new (models from daemon) · session/prompt (streaming `session/update`: message/thought chunks, tool calls) · permission requests mapped to `session/request_permission` · `session/set_mode` · `session/set_model` · `session/cancel`. Phase 2: resume/loadSession, compact, fork.

## Env knobs

- `ZCODE_SERVE_BIN` — zcode launcher override (default: `~/.zcode/server/bin/zcode`, then PATH)
- `ZCODE_SERVE_ACP_DEBUG=1` — verbose logs on stderr
- `ZCODE_SERVE_ACP_DUMP=1` — dump first conversation frames (protocol debugging)

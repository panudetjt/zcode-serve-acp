# T3 Code client contract for this bridge

Distilled from the reference clone in `.repos/t3code/` (pingdotgg/t3code).
This is the OTHER end of the ACP wire — the Client that launches this Bridge
as its "Local ACP command". These are the client-side facts this codebase
codes against; verify against the clone (cite file/line) before recording new
ones. Paths are relative to the clone root. (The sibling doc
[t3code.md](./t3code.md) covers the other direction: what a native per-agent
shim inside that clone must look like.)

## Process lifecycle: the Client never auto-respawns

- The Bridge is spawned from the provider settings: PATH-resolved executable,
  `shell: false`, settings args, instance env merged over the host env
  (`packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:1941-1963`,
  `packages/provider-acp-registry/src/server/adapter.ts:163-172`). Windows
  `.cmd`/`.bat` wrappers are rejected — launch without a shell.
- When the Bridge process dies, there is **no watchdog respawn**. The exit is
  turned into `AcpProcessExitedError` (exit code/signal, stderr tail attached)
  (`packages/effect-acp/src/_internal/stdio.ts:52-75`), pending JSON-RPC
  requests are failed and the connection is terminated
  (`packages/effect-acp/src/protocol.ts:865-889`), the runtime marks
  `runtimeRestartRequired`, and an in-flight turn is finalized failed with
  class `transport_error`
  (`packages/provider-acp/src/server/adapter.ts:2696-2757`).
- **Restart happens lazily on the NEXT turn**: `startTurnUnlocked` awaits the
  teardown and restarts the runtime, which re-runs `session/new` /
  `session/load`
  (`packages/provider-acp/src/server/adapter.ts:9146-9163`,
  `restartRuntimeAfterTeardownIfRequired` at 8938-8956).
- **Design consequence (issue #5)**: when the daemon is unreachable after the
  bounded reconnect budget, exiting non-zero is the RIGHT fallback — the
  Client treats a clean process exit as recoverable on the next prompt,
  whereas an answered `-32000` reads as a provider failure and the user sees
  the default `DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed."`
  (`packages/provider-core/src/server/failure.ts:41`).
- Teardown kills the whole process tree: SIGTERM → 1s grace → SIGKILL
  (`packages/provider-acp/src/server/AcpSessionRuntime.ts:1667-1673`).

## No client-side prompt timeout

There is **no timeout on `initialize` or `session/prompt`**. The only
mechanism is an optional `promptInactivityTimeout` flavor setting that no
flavor in the repo sets (`packages/provider-acp/src/server/adapter.ts:666`).
A Bridge that spends seconds on recovery before answering keeps that latency
invisible to the Client. (`session/load` is the exception: 90s default with a
replay-idle readiness mode, `AcpSessionRuntime.ts:87,2121-2170`.)

## Wire: newline-delimited JSON-RPC 2.0 over stdio

- A malformed agent line **ends the session** — the strict ndjson parser never
  skips bad lines (`packages/effect-acp/src/protocol.ts:193-196`). stdout is
  the ACP wire; anything logged to stdout is a protocol violation.
- `PROTOCOL_VERSION = 2`
  (`packages/effect-acp/src/_generated/meta.gen.ts:40`). The initialize
  request carries both v1 and v2 field names, and the response "generation" is
  sniffed by shape (`"info" in response`), not by the version number
  (`packages/effect-acp/src/client.ts:709-723`) — report version 2 with the v2
  response shape.
- Notifications go out without `id`; request ids start at 2^30 for SDKs that
  decode ids as Int (`packages/effect-acp/src/protocol.ts:295-298`). Keep the
  Bridge's own id space modest and distinct.
- Undecodable `session/update` payloads are dropped with a once-per-failure
  warning, not fatal (`packages/effect-acp/src/protocol.ts:645-670`).

## Requests the Client sends the Bridge

- `initialize` `{ protocolVersion: 2, clientCapabilities, clientInfo }` —
  capabilities include `fs`, `terminal`, `elicitation`, `session`
  (`AcpSessionRuntime.ts:1850-1865`). The registry flavor advertises
  `elicitation: { form: {} }`
  (`packages/provider-acp-registry/src/server/adapter.ts:2777-2785`).
- `session/new` `{ cwd, mcpServers, additionalDirectories? }`.
- Resume: `session/load` (v1 shape) when the agent advertises
  `loadSession === true`, else `session/resume` when
  `sessionCapabilities.resume != null`, else `-32601`
  (`AcpSessionRuntime.ts:2422-2448`). **The Bridge advertises `loadSession`**
  (see `scripts/smoke.mjs` output), so the Client replays via `session/load`.
- `session/prompt` `{ sessionId, prompt }` — in v2 the call resolves on the
  `session/update` `state_update state:"idle"` notification carrying
  `stopReason` (`packages/effect-acp/src/client.ts:1273-1304`), not on the
  RPC response alone.
- `session/cancel` (notification), `session/set_config_option` for
  mode/model (legacy `session/set_mode`/`session/set_model` only for v1
  agents that advertise `modes` but no config option,
  `AcpSessionRuntime.ts:2917-2970`).

## Requests the Bridge may send the Client (we must answer)

- `session/request_permission` →
  `{ outcome: { outcome: "selected", optionId } }` or
  `{ outcome: { outcome: "cancelled" } }` — T3 answers `cancelled` when no
  offered option matches its policy
  (`packages/provider-acp/src/server/adapter.ts:7299-7315`).
- `elicitation/create` → `{ action: "accept", content }` / `decline` /
  `cancel`; unparseable forms are declined, dismissed dialogs cancel
  (`packages/provider-acp/src/server/elicitationForm.ts:181-267`).
- `fs/read_text_file` / `fs/write_text_file` / `terminal/*` only exist when
  the corresponding capability was advertised — the Bridge advertises none,
  so it must never receive them.
- Every request needs a response (a JSON-RPC error response is acceptable);
  a hanging request hangs the Client's turn.

## Capability negotiation details worth remembering

- `loadSession`, `sessionCapabilities.*`, `promptCapabilities` (image/audio/
  embeddedContext), `mcpCapabilities` (server transport selection),
  `authMethods` (`packages/effect-acp/src/compat.ts:83-127`). Headless
  sessions refuse `terminal`/`env_var` auth methods
  (`AcpSessionRuntime.ts:2385-2394`).
- Slash commands arrive live via the `available_commands_update` session
  update; modes via `current_mode_update`
  (`packages/effect-acp/src/compat.ts:337-364`).
- `-32000` auth-required from `session/new` triggers `authenticate` + retry
  (`AcpSessionRuntime.ts:1086-1088,2480-2486`).
- `session/unload` does not exist in the client repo (it references unload
  nowhere in `packages/`/`apps/`); the Client uses `session/close` /
  `session/delete` explicitly and otherwise drops sessions implicitly.

## Stderr is diagnostics, stdout is never logged

Client keeps a redacted 4KiB stderr tail and appends it to process-exit error
messages for the user (`packages/provider-acp/src/server/stderr.ts`,
`AcpSessionRuntime.ts:1343-1364`); protocol logs go to an ndjson event log
(`packages/provider-acp/src/server/nativeLogging.ts`). Keep this Bridge's
logging on stderr only.

# T3 Code ACP provider shim — facts for a future `zcodeAcp.ts`

Distilled from the vendored clone in `.repos/t3code/` (pingdotgg/t3code).
Read-only reference — never import from it; this doc is what the codebase
remembers. Goal: when the T3 owner opens the door, a `zcodeAcp.ts` shim is a
single-PR contribution, and this page is the spec.

## Where shims live

- One file per agent: `packages/provider-acp-registry/src/server/<agent>Acp.ts`
  (claudeAcp.ts, devinAcp.ts, copilotAcp.ts, kimiAcp.ts, …). `claudeAcp.ts`
  is the canonical minimal one — 119 lines, pure functions, no side effects.
- The registry adapter (`provider-acp-registry/src/server/adapter.ts`) wires
  the exported functions into adapter-v2 options under a provider condition:
  `...(isClaude ? { extractSubagentUpdate: extractClaudeSubagentUpdate, … } : {})`.
  A `zcodeAcp.ts` is added the same way: exports + one conditional block +
  an `isZcode` detection (initialize reply / driver kind), nothing else.

## What the adapter-v2 hooks expect

From `packages/provider-acp/src/server/adapter.ts` (types + optional hooks):

- `isProvisionalSubagentTool(toolCall)` — mark Agent/Task-ish tool calls as
  subagent cards before real identity arrives.
- `extractSubagentUpdate(toolCall) → AcpAdapterV2SubagentUpdate | undefined` —
  `{ nativeTaskId, prompt, title, model, status, childSessionId, result,
  suppressNormalTool? }`; status: `pending|running|idle|completed|failed|
  interrupted|cancelled`. `childSessionId` is what makes T3 drill down into
  the child conversation.
- `extractSubagentSessionEvent(notification) → AcpSubagentSessionEvent |
  undefined` — `{ type: "state", childSessionId, parentSessionId, status,
  result }` or `{ type: "delegation", …, delegationId, prompt }`.

## The proprietary-update channel

Standard ACP has no subagent updates, so providers smuggle them through the
compat layer's `_t3_unknown` session update: `update.sessionUpdate ===
"_t3_unknown"` plus `update.originalSessionUpdate` (`"subagent_update"`,
`"session_message"`) and the raw payload in `update.raw` — all decoded with
tolerant `Schema.decodeUnknownOption` shims exactly like claudeAcp.ts:60-119.

For zcode this maps directly onto what this bridge already emits: tool calls
with `name: "subagent"` (+ `_meta: { backgrounded, workId }`) feed
`extractSubagentUpdate`; if we later emit `_t3_unknown`/`subagent_update`
updates carrying `{ sessionId, state }` per child (the daemon's own child
shape), `extractSubagentSessionEvent` becomes trivial. Our zcode `childSessionId`
from the subagent row / `session/subagents` RPC is the drill-down key T3 wants.

## House rules seen in the shims (match them)

- Decode everything with `Schema.decodeUnknownOption(…)` — never `as` casts.
- Return `undefined` (not errors) when a payload isn't yours.
- Keep status mapping explicit and total (claudeAcp.ts:50-57, 95-103).
- File-scoped: no imports beyond effect + `@t3tools/provider-*` type imports.
- Registration is data, not code: one spread block in `adapter.ts`.

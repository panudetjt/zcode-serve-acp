# zcode-serve-acp

An Agent Client Protocol (ACP) bridge that sits between an ACP-speaking coding client (stdio) and the ZCode daemon, so the daemon alone owns credentials and the client never touches secrets.

## Language

**Bridge**:
This process — the translator between a Client and the Daemon. Lives as long as its stdin does.
_Avoid_: proxy, adapter, acp-server

**Client**:
The ACP speaker on the other end of stdio (e.g. T3 Code configured with a "Local ACP command").
_Avoid_: IDE, user, host

**Daemon**:
The `zcode serve` background server (runtime `~/.zcode/server/…`) that owns credentials, sessions, and conversation execution. Never killed by the Bridge.
_Avoid_: server, serve, backend

**Capability token**:
A short-TTL, single-use credential the Bridge fetches to authorize exactly one Channel attach.

**Channel**:
The binary WebSocket RPC connection between Bridge and Daemon, authorized by ingress token + capability token.
_Avoid_: socket, connection

**Wire codec**:
The hand-rolled binary encoding of Channel messages (frame headers, tagged values, varints), reverse-engineered from the daemon's `server-core.js`.

**Conversation frame**:
A daemon-published delta describing changes in one conversation — row appends/upserts, state transitions, pending interactions.
_Avoid_: event, message, delta

**Row**:
One item in the daemon's conversation transcript: assistant text, thought, or tool call.

**Turn**:
One Client prompt plus the Daemon's streamed response, ending in a **Stop reason** (completed / cancelled / failed).
_Avoid_: prompt, request

**Pending interaction**:
A Daemon request that needs a human decision, surfacing as either a Permission request or an Elicitation.
_Avoid_: approval, prompt request

**Permission request**:
An allow/deny decision (with selectable outcome options) on a tool call, forwarded to the Client as `session/request_permission`.

**Elicitation**:
A structured form question (AskUserQuestion-style) forwarded to the Client as `elicitation/create` — distinct from a Permission request's allow/deny shape.

## Rewrite contract terms

**Drop-in replacement**:
The rewritten Bridge keeps binary name, env vars, and ACP surface identical, so existing Client config keeps working unmodified.

**Behavior-preserving port**:
A rewrite that changes only the listed known bugs — never the feature set.

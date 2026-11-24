/**
 * Orphan tool-part heal — closes tool calls a crashed Turn left open in the
 * daemon's conversation store.
 *
 * When a Turn dies between "the model asked for a tool" and "the tool's result
 * was persisted", its `part` row stays `state.status: "pending"` or
 * `"running"` with no result. Every later Turn in that runtime then fails at
 * request serialisation with `AI_MissingToolResultsError` ("Model request
 * failed."), because the runtime sends the model its in-memory history and that
 * history holds a tool call without a result.
 *
 * Two facts decide what this service can and cannot do (runtime 3.19.1):
 *
 * 1. A live Turn never re-reads these rows. Verified 2026-11-24 on a scratch
 *    session: a row patched between two prompts (by this very heal) did not
 *    change what the next Turn saw. Healing a row therefore does not unwedge
 *    the runtime that is stuck — only a runtime restart does, after which the
 *    daemon rebuilds its history from the store
 *    (`hydrateMessageHistoryFromSession`, zcode.cjs). The caller pairs this
 *    with `ServeSession.restartRuntime`.
 * 2. The daemon never rewrites an interrupted row itself: on (re)load it only
 *    substitutes a result in memory (`addToolResultsFromParts`: completed →
 *    output, error → state.error, anything else → "[Tool execution was
 *    interrupted before resume]"). Without this heal the store keeps the open
 *    row forever.
 *
 * Provenance — daemon storage protocol, reverse-engineered from the live
 * `cli/db/db.sqlite` (runtime 3.19.1, SQLite 3.53.4, journal_mode = wal) on
 * 2026-11-24:
 *
 *   CREATE TABLE part (
 *     id text primary key,
 *     message_id text not null references message(id) on delete cascade,
 *     session_id text not null,
 *     time_created integer not null,   -- epoch milliseconds
 *     time_updated integer not null,   -- epoch milliseconds
 *     data text not null,              -- compact JSON, no space after ':'
 *     sequence integer)
 *   CREATE INDEX part_session_idx on part(session_id)
 *   -- before-update triggers session_purge_part_update and
 *   -- session_purge_reference_part_data_update abort with
 *   -- 'session-data.deleting' while the session is being purged.
 *
 * A tool part's `data` is `{type:"tool", callID, blockIndex, tool, metadata?,
 * state:{status, input, …}}` and `state.status` is one of `pending`, `running`,
 * `completed`, `error`. Only the last two are closed: `completed` carries
 * `state.output`, `error` carries `state.error` (text) and `state.time
 * {start, end}` — the shape this heal writes.
 */
import { Clock, Context, Effect, Layer, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Schema } from "effect"
import path from "node:path"
import { RecoveryError } from "../errors.ts"
import { dataRoot } from "./daemon.ts"
import { Sqlite, type SqliteConnection } from "./sqlite.ts"

export interface HealedToolPart {
  readonly id: string
  readonly callId: string
  readonly tool: string
}

export interface RecoveryResult {
  /** Empty when there was nothing to close. */
  readonly healedParts: readonly HealedToolPart[]
}

export const defaultDbPath = (): string => path.join(dataRoot(), ".zcode", "cli", "db", "db.sqlite")

/** Written into `state.error`, so the model is told the tool never ran to completion rather than left without a result. */
const HEAL_ERROR = "[Bridge Auto-Recovery] Tool execution was interrupted by runtime failure"

/**
 * How long a heal waits for a write lock another process holds. The call is
 * synchronous on the Bridge's event loop, so this bounds how long every other
 * ACP session in the process stalls: the daemon's own writes hold the lock for
 * milliseconds, and under heavier contention the heal fails fast with
 * `SQLITE_BUSY` and the next prompt tries again (measured 2026-11-24: a 5 s
 * timeout stalled the loop for the full 5 s under a held lock).
 */
export const HEAL_BUSY_TIMEOUT_MS = 100

/** Tool-part states with no result persisted: a crash left the call open. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "running"])

/** The fields of a stored tool part this service reads. Everything else in `data` is left as it is. */
const StoredToolPart = Schema.Struct({
  type: Schema.String,
  callID: Schema.String,
  tool: Schema.String,
  state: Schema.Struct({ status: Schema.String })
})
type StoredToolPart = typeof StoredToolPart.Type
const decodeStoredToolPart = Schema.decodeUnknownOption(StoredToolPart)

const placeholders = (): string => [...OPEN_STATUSES].map(() => "?").join(", ")

/**
 * Open tool parts of one session. The LIKE pair is a cheap prefilter over the
 * session's rows (compact JSON, and an open tool part always contains its
 * status literal); the exact test runs on the survivors only, so a completed
 * tool whose *input or output* happens to contain `"status":"pending"` (todo
 * lists do) is never a candidate. `CASE` keeps `json_extract` off malformed
 * documents, which it would otherwise reject the whole query on.
 */
const selectCandidates = (sessionId: string): { sql: string; params: Array<string | number> } => ({
  sql: `
    SELECT id, data FROM (
      SELECT id, data FROM part
      WHERE session_id = ?
        AND (data LIKE '%"status":"pending"%' OR data LIKE '%"status":"running"%')
    )
    WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.type') END = 'tool'
      AND CASE WHEN json_valid(data) THEN json_extract(data, '$.state.status') END IN (${placeholders()})
  `,
  params: [sessionId, ...OPEN_STATUSES]
})

/**
 * Closes one open tool part in place. `json_set` rewrites only the three
 * state keys, so every other field of the daemon's document is left as it is.
 * The status predicate re-checks under the write lock that the part is still
 * open: a result the daemon persisted after the candidate read turns the
 * statement into a no-op (`changes = 0`).
 */
const healPart = (db: SqliteConnection, sessionId: string, part: StoredToolPart, id: string, now: number): boolean =>
  db.run(
    `
    UPDATE part
    SET data = json_set(
          data,
          '$.state.status', 'error',
          '$.state.error', ?,
          '$.state.time', json_object(
            'start', coalesce(json_extract(data, '$.state.time.start'), time_created),
            'end', ?
          )
        ),
        time_updated = ?
    WHERE id = ? AND session_id = ?
      AND CASE WHEN json_valid(data) THEN json_extract(data, '$.type') END = 'tool'
      AND CASE WHEN json_valid(data) THEN json_extract(data, '$.state.status') END IN (${placeholders()})
  `,
    HEAL_ERROR,
    now,
    now,
    id,
    sessionId,
    ...OPEN_STATUSES
  ) === 1

const heal = (db: SqliteConnection, sessionId: string, now: number): Array<HealedToolPart> => {
  const { sql, params } = selectCandidates(sessionId)
  const candidates = db.all<{ id: string; data: string }>(sql, ...params)
  if (candidates.length === 0) return []
  return db.transaction(() => {
    const healed: Array<HealedToolPart> = []
    for (const candidate of candidates) {
      // The candidate query already established the row is valid JSON of an
      // open tool part; a document that still does not decode is left alone.
      // A driver failure below is not caught here — it has to reach the
      // caller instead of passing for "nothing healed".
      const part = decodeStoredToolPart(JSON.parse(candidate.data))
      if (Option.isNone(part) || !OPEN_STATUSES.has(part.value.state.status)) continue
      if (healPart(db, sessionId, part.value, candidate.id, now)) {
        healed.push({ id: candidate.id, callId: part.value.callID, tool: part.value.tool })
      }
    }
    return healed
  })
}

export class SessionRecovery extends Context.Service<
  SessionRecovery,
  {
    /**
     * Closes every open tool part of `sessionId` in the daemon's store. The
     * caller knows the Turn state and must not call this while a Turn of that
     * session may still be running — an in-flight tool is open too.
     */
    readonly healSession: (sessionId: string) => Effect.Effect<RecoveryResult, RecoveryError>
  }
>()("zcode-serve-acp/SessionRecovery") {
  static readonly make = (options?: {
    readonly dbPath?: () => string
    readonly busyTimeoutMs?: number
  }): Layer.Layer<SessionRecovery, never, FileSystem | Sqlite> =>
    Layer.effect(
      SessionRecovery,
      Effect.gen(function* () {
        const fs = yield* FileSystem
        const sqlite = yield* Sqlite
        const dbPath = options?.dbPath ?? defaultDbPath
        const busyTimeoutMs = options?.busyTimeoutMs ?? HEAL_BUSY_TIMEOUT_MS
        return SessionRecovery.of({
          healSession: Effect.fn("SessionRecovery.healSession")(function* (sessionId) {
            if (sessionId.trim() === "") return { healedParts: [] }
            const target = dbPath()
            const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))
            if (!exists) {
              return yield* new RecoveryError({ sessionId, message: `daemon store not found at ${target}` })
            }
            const now = yield* Clock.currentTimeMillis
            const healedParts = yield* sqlite
              .withConnection(target, busyTimeoutMs, (db) => heal(db, sessionId, now))
              .pipe(
                Effect.mapError(
                  (cause) => new RecoveryError({ sessionId, message: `daemon store ${target}: ${cause.message}` })
                )
              )
            return { healedParts }
          })
        })
      })
    )

  static readonly layerNoDeps: Layer.Layer<SessionRecovery, never, FileSystem | Sqlite> = SessionRecovery.make()
}

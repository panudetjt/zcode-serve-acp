/**
 * Session auto-recovery and self-healing service.
 *
 * Repairs wedged sessions caused by unclosed tool calls (e.g. SQLite database
 * lock contention, process interruption, or abort during tool execution).
 *
 * In ZCode, an assistant tool call is recorded into the `part` table before the
 * tool result arrives. If the turn aborts before `commitTurnRequestEntries`,
 * the tool part remains with `state.status: "pending"`. On subsequent turns,
 * Vercel AI SDK throws `AI_MissingToolResultsError` ("Tool result is missing
 * for tool call..."), wedging the thread permanently.
 *
 * This service inspects the session's parts in `db.sqlite` and patches orphan
 * pending tool parts to `status: "error"`, satisfying the LLM serializer invariant
 * and unblocking subsequent turns without user intervention.
 */
import { Database } from "bun:sqlite"
import { Clock, Context, Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import path from "node:path"
import { RecoveryError, renderError } from "../errors.ts"
import { Log } from "../log.ts"
import { dataRoot } from "./daemon.ts"

export interface HealedToolPart {
  readonly id: string
  readonly callId: string
  readonly tool: string
}

export interface RecoveryResult {
  readonly checked: boolean
  readonly healedCount: number
  readonly healedParts: readonly HealedToolPart[]
}

export const defaultDbPath = (): string => path.join(dataRoot(), ".zcode", "cli", "db", "db.sqlite")

const healSessionImpl = (
  fs: FileSystem,
  log: Log["Service"],
  customDbPath: string | undefined,
  sessionId: string
): Effect.Effect<RecoveryResult, RecoveryError> =>
  Effect.gen(function* () {
    if (!sessionId || sessionId.trim() === "") {
      return { checked: false, healedCount: 0, healedParts: [] }
    }
    const targetDb = customDbPath ?? defaultDbPath()
    const exists = yield* fs.exists(targetDb).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      yield* log.debug(`[recovery] db not found at ${targetDb}, skipping heal for ${sessionId}`)
      return { checked: false, healedCount: 0, healedParts: [] }
    }

    const now = yield* Clock.currentTimeMillis

    return yield* Effect.try({
      try: () => {
        const db = new Database(targetDb, { create: false, readwrite: true })
        try {
          db.run("PRAGMA busy_timeout = 5000;")
          const selectStmt = db.query<{ id: string; data: string }, [string]>(`
            SELECT id, data
            FROM part
            WHERE session_id = ?
              AND data LIKE '%"type":"tool"%'
              AND data LIKE '%"status":"pending"%'
          `)
          const rows = selectStmt.all(sessionId)
          if (rows.length === 0) {
            return { checked: true, healedCount: 0, healedParts: [] }
          }

          const updateStmt = db.query<void, [string, number, string]>(`
            UPDATE part SET data = ?, time_updated = ? WHERE id = ?
          `)

          const healedParts: HealedToolPart[] = []

          const tx = db.transaction(() => {
            for (const row of rows) {
              try {
                const parsed = JSON.parse(row.data)
                if (parsed.type === "tool" && parsed.state?.status === "pending") {
                  const callId = String(parsed.callID ?? parsed.id ?? "")
                  const tool = String(parsed.tool ?? "")
                  parsed.state = {
                    ...parsed.state,
                    status: "error",
                    error: "[Bridge Auto-Recovery] Tool execution was interrupted by runtime failure",
                    time: {
                      start: parsed.state?.time?.start ?? now,
                      end: now
                    }
                  }
                  updateStmt.run(JSON.stringify(parsed), now, row.id)
                  healedParts.push({ id: row.id, callId, tool })
                }
              } catch {
                // Ignore malformed JSON in unmanaged parts
              }
            }
          })

          tx()

          return {
            checked: true,
            healedCount: healedParts.length,
            healedParts
          }
        } finally {
          db.close()
        }
      },
      catch: (cause) =>
        new RecoveryError({
          sessionId,
          message: `Failed to heal session ${sessionId}: ${renderError(cause)}`
        })
    })
  })

export class SessionRecovery extends Context.Service<
  SessionRecovery,
  {
    readonly healSession: (sessionId: string) => Effect.Effect<RecoveryResult, RecoveryError>
  }
>()("zcode-serve-acp/SessionRecovery") {
  static readonly layerNoDeps: Layer.Layer<SessionRecovery, never, FileSystem | Log> = Layer.effect(
    SessionRecovery,
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const log = yield* Log
      return SessionRecovery.of({
        healSession: (sessionId) => healSessionImpl(fs, log, undefined, sessionId)
      })
    })
  )

  static readonly make = (customDbPath?: string): Layer.Layer<SessionRecovery, never, FileSystem | Log> =>
    Layer.effect(
      SessionRecovery,
      Effect.gen(function* () {
        const fs = yield* FileSystem
        const log = yield* Log
        return SessionRecovery.of({
          healSession: (sessionId) => healSessionImpl(fs, log, customDbPath, sessionId)
        })
      })
    )
}

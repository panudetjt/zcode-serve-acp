import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Cause, Clock, Effect, Exit, Layer, Option } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RecoveryError, SqliteError } from "../src/errors.ts"
import { defaultDbPath, HEAL_BUSY_TIMEOUT_MS, SessionRecovery, type RecoveryResult } from "../src/serve/recovery.ts"
import { Sqlite, type SqliteConnection, type SqliteValue } from "../src/serve/sqlite.ts"
import { BunSqlite } from "../src/serve/sqlite-bun.ts"

/**
 * The daemon's `part` table as the live store has it (runtime 3.19.1 — see the
 * provenance block in src/serve/recovery.ts), on a real temp database.
 */
const PART_DDL = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE part (
    id text primary key,
    message_id text not null references message(id) on delete cascade,
    session_id text not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null,
    sequence integer
  );
  CREATE INDEX part_session_idx on part(session_id);
  CREATE TABLE session_purge (session_id text primary key, state text not null);
  CREATE TRIGGER session_purge_part_update before update on part
    when exists(select 1 from session_purge where session_id=new.session_id)
    begin select raise(abort, 'session-data.deleting'); end;
`

const MARKER = "[Bridge Auto-Recovery] Tool execution was interrupted by runtime failure"
const SESSION = "sess_heal_target"
const OTHER_SESSION = "sess_heal_other"
const T0 = 1_795_000_000_000

/** The error a failed Exit carries (its cause is a Cause, not the error itself). */
const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

interface PartSpec {
  readonly id: string
  readonly sessionId?: string
  readonly data: string
  readonly timeCreated?: number
}

/** A stored tool part in the daemon's compact-JSON shape, with the fields a real row carries. */
const toolPart = (fields: {
  callID: string
  tool: string
  status: string
  input?: unknown
  state?: Record<string, unknown>
  extra?: Record<string, unknown>
}): string =>
  JSON.stringify({
    type: "tool",
    callID: fields.callID,
    blockIndex: 0,
    tool: fields.tool,
    metadata: { providerMetadata: { source: "test" } },
    state: { status: fields.status, input: fields.input ?? { command: "ls" }, ...fields.state },
    ...fields.extra
  })

describe("SessionRecovery service", () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-heal-test-"))
    dbPath = path.join(tmpDir, "db.sqlite")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createStore = (parts: ReadonlyArray<PartSpec> = []): void => {
    const db = new Database(dbPath, { create: true })
    db.exec(PART_DDL)
    const insert = db.query(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    )
    for (const part of parts) {
      insert.run(
        part.id,
        `msg_${part.id}`,
        part.sessionId ?? SESSION,
        part.timeCreated ?? T0,
        part.timeCreated ?? T0,
        part.data
      )
    }
    db.close()
  }

  const makeRecovery = (busyTimeoutMs: number = HEAL_BUSY_TIMEOUT_MS) =>
    Effect.runPromise(
      SessionRecovery.pipe(
        Effect.provide(SessionRecovery.make({ dbPath: () => dbPath, busyTimeoutMs })),
        Effect.provide(BunFileSystem.layer),
        Effect.provide(BunSqlite.layer)
      )
    )

  const heal = async (sessionId: string = SESSION, busyTimeoutMs?: number): Promise<RecoveryResult> => {
    const recovery = await makeRecovery(busyTimeoutMs)
    return Effect.runPromise(recovery.healSession(sessionId))
  }

  const healExit = async (busyTimeoutMs?: number) => {
    const recovery = await makeRecovery(busyTimeoutMs)
    return Effect.runPromiseExit(recovery.healSession(SESSION))
  }

  const readPart = (id: string): { data: string; time_updated: number } | null => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return db
        .query<{ data: string; time_updated: number }, [string]>("SELECT data, time_updated FROM part WHERE id = ?")
        .get(id)
    } finally {
      db.close()
    }
  }

  /** Holds the store's write lock on a second connection, the way the daemon does while it writes. */
  const holdWriteLock = (): Database => {
    const holder = new Database(dbPath, { create: false, readwrite: true })
    holder.run("BEGIN IMMEDIATE")
    return holder
  }

  test("closes a pending tool part and leaves every other field of the document as it is", async () => {
    const data = toolPart({
      callID: "call_todo_1",
      tool: "TodoWrite",
      status: "pending",
      input: { todos: [{ content: "do work", status: "pending" }] },
      state: { raw: '{"todos":[]}' },
      extra: { declarationIndex: 3, source: "model" }
    })
    createStore([{ id: "part_pending", data, timeCreated: T0 + 5 }])
    const before = await Effect.runPromise(Clock.currentTimeMillis)

    const result = await heal()

    expect(result.healedParts).toEqual([{ id: "part_pending", callId: "call_todo_1", tool: "TodoWrite" }])
    const row = readPart("part_pending")
    expect(row).toBeDefined()
    const parsed = JSON.parse(row!.data)
    expect(parsed.state.status).toBe("error")
    expect(parsed.state.error).toBe(MARKER)
    // A pending part has no start time of its own: the call's creation time is the honest one.
    expect(parsed.state.time.start).toBe(T0 + 5)
    expect(parsed.state.time.end).toBeGreaterThanOrEqual(before)
    expect(row!.time_updated).toBe(parsed.state.time.end)
    const { state, ...envelope } = parsed
    const { status: _status, error: _error, time: _time, ...stateRest } = state
    expect(envelope).toEqual({
      type: "tool",
      callID: "call_todo_1",
      blockIndex: 0,
      tool: "TodoWrite",
      metadata: { providerMetadata: { source: "test" } },
      declarationIndex: 3,
      source: "model"
    })
    expect(stateRest).toEqual({ input: { todos: [{ content: "do work", status: "pending" }] }, raw: '{"todos":[]}' })
  })

  test("closes a running tool part too, keeping the start time it already had", async () => {
    const start = T0 + 10
    createStore([
      {
        id: "part_running",
        data: toolPart({
          callID: "call_bash_1",
          tool: "Bash",
          status: "running",
          input: { command: "make" },
          state: { title: "make", time: { start } }
        })
      }
    ])

    const result = await heal()

    expect(result.healedParts).toEqual([{ id: "part_running", callId: "call_bash_1", tool: "Bash" }])
    const state = JSON.parse(readPart("part_running")!.data).state
    expect(state.status).toBe("error")
    expect(state.error).toBe(MARKER)
    expect(state.time.start).toBe(start)
    expect(state.time.end).toBeGreaterThan(start)
    expect(state.title).toBe("make")
  })

  test("never touches closed parts, even when their input or output contains a pending status literal", async () => {
    const completed = toolPart({
      callID: "call_done",
      tool: "TodoWrite",
      status: "completed",
      input: { todos: [{ content: "ship it", status: "pending" }] },
      state: { output: { todos: [{ content: "ship it", status: "pending" }] }, time: { start: T0, end: T0 + 1 } }
    })
    const errored = toolPart({
      callID: "call_err",
      tool: "Bash",
      status: "error",
      state: { error: "exit 1", time: { start: T0, end: T0 + 2 } }
    })
    createStore([
      { id: "part_done", data: completed },
      { id: "part_err", data: errored }
    ])

    const result = await heal()

    expect(result.healedParts).toEqual([])
    expect(readPart("part_done")!.data).toBe(completed)
    expect(readPart("part_err")!.data).toBe(errored)
  })

  test("only heals the session it is asked about", async () => {
    const foreign = toolPart({ callID: "call_other", tool: "Bash", status: "pending" })
    createStore([
      { id: "part_mine", data: toolPart({ callID: "call_mine", tool: "Bash", status: "pending" }) },
      { id: "part_other", sessionId: OTHER_SESSION, data: foreign }
    ])

    expect((await heal()).healedParts.map((part) => part.id)).toEqual(["part_mine"])
    expect(readPart("part_other")!.data).toBe(foreign)
  })

  test("skips rows it cannot name: malformed JSON, non-tool parts, tool parts without a call id", async () => {
    createStore([
      { id: "part_malformed", data: '{"type":"tool", "status":"pending" INVALID_JSON' },
      { id: "part_text", data: JSON.stringify({ type: "text", text: 'todo "status":"pending"' }) },
      { id: "part_no_call", data: JSON.stringify({ type: "tool", tool: "Bash", state: { status: "pending" } }) }
    ])

    const result = await heal()

    expect(result.healedParts).toEqual([])
    expect(readPart("part_malformed")!.data).toBe('{"type":"tool", "status":"pending" INVALID_JSON')
    expect(JSON.parse(readPart("part_text")!.data).type).toBe("text")
    expect(JSON.parse(readPart("part_no_call")!.data).state.status).toBe("pending")
  })

  test("is idempotent: a second heal finds nothing left to close", async () => {
    createStore([{ id: "part_once", data: toolPart({ callID: "call_once", tool: "Bash", status: "pending" }) }])

    expect((await heal()).healedParts).toHaveLength(1)
    expect((await heal()).healedParts).toEqual([])
    expect(JSON.parse(readPart("part_once")!.data).state.error).toBe(MARKER)
  })

  test("treats an empty session id as nothing to do", async () => {
    createStore()
    expect((await heal("")).healedParts).toEqual([])
    expect((await heal("   ")).healedParts).toEqual([])
  })

  test("fails with RecoveryError when the daemon store does not exist", async () => {
    const exit = await healExit()

    const error = errorOf(exit)
    expect(error).toBeInstanceOf(RecoveryError)
    expect((error as RecoveryError).message).toContain(dbPath)
  })

  test("fails with RecoveryError while the daemon holds the write lock, and heals once it is released", async () => {
    createStore([{ id: "part_locked", data: toolPart({ callID: "call_locked", tool: "Bash", status: "pending" }) }])
    const holder = holdWriteLock()
    try {
      const error = errorOf(await healExit(40))
      expect(error).toBeInstanceOf(RecoveryError)
      expect((error as RecoveryError).message).toContain("locked")
      expect(JSON.parse(readPart("part_locked")!.data).state.status).toBe("pending")
    } finally {
      holder.run("ROLLBACK")
      holder.close()
    }

    expect((await heal()).healedParts.map((part) => part.id)).toEqual(["part_locked"])
  })

  test("gives up on a held lock within the short busy timeout instead of stalling the event loop", async () => {
    createStore([{ id: "part_busy", data: toolPart({ callID: "call_busy", tool: "Bash", status: "pending" }) }])
    const holder = holdWriteLock()
    const started = performance.now()
    try {
      const exit = await healExit()
      const elapsed = performance.now() - started
      expect(Exit.isFailure(exit)).toBe(true)
      // The call is synchronous: everything else in the Bridge process waits this long.
      expect(elapsed).toBeGreaterThanOrEqual(HEAL_BUSY_TIMEOUT_MS - 10)
      expect(elapsed).toBeLessThan(2000)
    } finally {
      holder.run("ROLLBACK")
      holder.close()
    }
  })

  test("does not heal a part the daemon closed between the candidate read and the write", async () => {
    const closedByDaemon = toolPart({
      callID: "call_raced",
      tool: "Bash",
      status: "completed",
      state: { output: "done", time: { start: T0, end: T0 + 9 } }
    })
    createStore([{ id: "part_raced", data: toolPart({ callID: "call_raced", tool: "Bash", status: "pending" }) }])
    // The real driver, with the daemon's write interpolated: right after the
    // candidate read a second connection persists the tool's result, before the
    // heal's transaction runs.
    const racing = Effect.gen(function* () {
      const driver = yield* Sqlite
      return Sqlite.of({
        withConnection: <A>(path: string, busyTimeoutMs: number, use: (db: SqliteConnection) => A) =>
          driver.withConnection(path, busyTimeoutMs, (db) =>
            use({
              ...db,
              all: <T>(sql: string, ...params: SqliteValue[]): Array<T> => {
                const rows = db.all<T>(sql, ...params)
                if (sql.includes("FROM part")) {
                  const daemon = new Database(dbPath, { create: false, readwrite: true })
                  try {
                    daemon.run("UPDATE part SET data = ? WHERE id = ?", [closedByDaemon, "part_raced"])
                  } finally {
                    daemon.close()
                  }
                }
                return rows
              }
            })
          )
      })
    }).pipe(Effect.provide(BunSqlite.layer))
    const sqlite = await Effect.runPromise(racing)
    const recovery = await Effect.runPromise(
      SessionRecovery.pipe(
        Effect.provide(SessionRecovery.make({ dbPath: () => dbPath })),
        Effect.provide(BunFileSystem.layer),
        Effect.provide(Layer.succeed(Sqlite, sqlite))
      )
    )

    expect((await Effect.runPromise(recovery.healSession(SESSION))).healedParts).toEqual([])
    expect(readPart("part_raced")!.data).toBe(closedByDaemon)
  })

  test("leaves the store alone and fails with RecoveryError while the daemon is purging the session", async () => {
    const data = toolPart({ callID: "call_purged", tool: "Bash", status: "pending" })
    createStore([{ id: "part_purged", data }])
    const db = new Database(dbPath)
    db.query("INSERT INTO session_purge (session_id, state) VALUES (?, ?)").run(SESSION, "deleting")
    db.close()

    const error = errorOf(await healExit())

    expect(error).toBeInstanceOf(RecoveryError)
    expect((error as RecoveryError).message).toContain("session-data.deleting")
    expect(readPart("part_purged")!.data).toBe(data)
  })

  test("defaultDbPath follows ZCODE_DATA_BASE_DIR, the way the daemon resolves its data root", () => {
    const original = process.env.ZCODE_DATA_BASE_DIR
    try {
      process.env.ZCODE_DATA_BASE_DIR = "/custom/zcode/data"
      expect(defaultDbPath()).toBe("/custom/zcode/data/.zcode/cli/db/db.sqlite")
    } finally {
      if (original !== undefined) process.env.ZCODE_DATA_BASE_DIR = original
      else delete process.env.ZCODE_DATA_BASE_DIR
    }
  })

  test("layerNoDeps heals the store under the data root", async () => {
    createStore([{ id: "part_default", data: toolPart({ callID: "call_default", tool: "Bash", status: "pending" }) }])
    const original = process.env.ZCODE_DATA_BASE_DIR
    try {
      process.env.ZCODE_DATA_BASE_DIR = tmpDir
      fs.mkdirSync(path.join(tmpDir, ".zcode", "cli", "db"), { recursive: true })
      fs.copyFileSync(dbPath, path.join(tmpDir, ".zcode", "cli", "db", "db.sqlite"))

      const recovery = await Effect.runPromise(
        SessionRecovery.pipe(
          Effect.provide(SessionRecovery.layerNoDeps),
          Effect.provide(BunFileSystem.layer),
          Effect.provide(BunSqlite.layer)
        )
      )

      expect((await Effect.runPromise(recovery.healSession(SESSION))).healedParts.map((part) => part.callId)).toEqual([
        "call_default"
      ])
    } finally {
      if (original !== undefined) process.env.ZCODE_DATA_BASE_DIR = original
      else delete process.env.ZCODE_DATA_BASE_DIR
    }
  })
})

describe("Sqlite port, Bun driver", () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-sqlite-test-"))
    dbPath = path.join(tmpDir, "db.sqlite")
    const db = new Database(dbPath, { create: true })
    db.exec("CREATE TABLE t (id text primary key, n integer)")
    db.close()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const withDb = <A>(fn: (db: SqliteConnection) => A, path: string = dbPath) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sqlite = yield* Sqlite
        return yield* sqlite.withConnection(path, 10, fn)
      }).pipe(Effect.provide(BunSqlite.layer))
    )

  test("reads rows, writes rows, and reports the number of changed rows", async () => {
    const rows = await withDb((db) => {
      const inserted = db.run("INSERT INTO t (id, n) VALUES (?, ?)", "a", 1)
      const missed = db.run("UPDATE t SET n = ? WHERE id = ?", 2, "nope")
      return { inserted, missed, all: db.all<{ id: string; n: number }>("SELECT id, n FROM t") }
    })

    expect(rows).toEqual({ inserted: 1, missed: 0, all: [{ id: "a", n: 1 }] })
  })

  test("commits a transaction, and rolls one back when the work throws — on the same connection too", async () => {
    const failure = new Error("boom")
    const outcome = await withDb((db) => {
      db.transaction(() => {
        db.run("INSERT INTO t (id, n) VALUES (?, ?)", "kept", 1)
      })
      let thrown: unknown
      try {
        db.transaction(() => {
          db.run("INSERT INTO t (id, n) VALUES (?, ?)", "rolled-back", 1)
          throw failure
        })
      } catch (cause) {
        thrown = cause
      }
      // The connection stays usable, and the failed transaction left nothing behind.
      return { thrown, visible: db.all<{ id: string }>("SELECT id FROM t ORDER BY id").map((row) => row.id) }
    })

    expect(outcome.thrown).toBe(failure)
    expect(outcome.visible).toEqual(["kept"])
    const ids = await withDb((db) => db.all<{ id: string }>("SELECT id FROM t").map((row) => row.id))
    expect(ids).toEqual(["kept"])
  })

  test("fails with SqliteError for a missing file, a bad statement, and a held lock", async () => {
    const driver = Effect.gen(function* () {
      const service = yield* Sqlite
      return {
        missing: yield* Effect.exit(service.withConnection(path.join(tmpDir, "missing.sqlite"), 10, () => 1)),
        badSql: yield* Effect.exit(service.withConnection(dbPath, 10, (db) => db.all("SELECT nope FROM nothing"))),
        busy: yield* Effect.exit(
          service.withConnection(dbPath, 20, (db) => db.transaction(() => db.run("UPDATE t SET n = 1")))
        )
      }
    }).pipe(Effect.provide(BunSqlite.layer))

    const holder = new Database(dbPath, { create: false, readwrite: true })
    holder.run("BEGIN IMMEDIATE")
    const results = await Effect.runPromise(driver)
    holder.run("ROLLBACK")
    holder.close()

    for (const key of ["missing", "badSql", "busy"] as const) {
      expect(errorOf(results[key])).toBeInstanceOf(SqliteError)
    }
    expect((errorOf(results.missing) as SqliteError).path).toBe(path.join(tmpDir, "missing.sqlite"))
    expect((errorOf(results.busy) as SqliteError).code).toContain("BUSY")
    // The failure carries the driver's message, so the log line says what went wrong.
    expect((errorOf(results.badSql) as SqliteError).message).not.toBe("")
  })

  test("clamps the busy timeout to a non-negative integer before it reaches the PRAGMA", async () => {
    // A negative timeout is a PRAGMA syntax error; a fraction is not an integer.
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Sqlite
        return yield* service.withConnection(dbPath, -5.7, (db) => db.all<{ n: number }>("SELECT 1 AS n"))
      }).pipe(Effect.provide(BunSqlite.layer))
    )
    expect(answer).toEqual([{ n: 1 }])
  })
})

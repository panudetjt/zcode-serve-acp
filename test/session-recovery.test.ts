import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Effect, Exit, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Log } from "../src/log.ts"
import { defaultDbPath, SessionRecovery } from "../src/serve/recovery.ts"

describe("SessionRecovery service", () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-recovery-test-"))
    dbPath = path.join(tmpDir, "db.sqlite")
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  const createTestDb = (): Database => {
    const db = new Database(dbPath, { create: true })
    db.run(`
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        sequence INTEGER
      );
    `)
    return db
  }

  const makeRecoveryService = (customPath?: string) => {
    const recoveryLayer = SessionRecovery.make(customPath ?? dbPath).pipe(
      Layer.provide(BunFileSystem.layer),
      Layer.provide(Log.layerQuiet)
    )
    return Effect.runPromise(SessionRecovery.pipe(Effect.provide(recoveryLayer)))
  }

  test("skips healing when sessionId is empty or whitespace", async () => {
    const recovery = await makeRecoveryService()
    const res1 = await Effect.runPromise(recovery.healSession(""))
    expect(res1.checked).toBe(false)
    expect(res1.healedCount).toBe(0)

    const res2 = await Effect.runPromise(recovery.healSession("   "))
    expect(res2.checked).toBe(false)
    expect(res2.healedCount).toBe(0)
  })

  test("skips healing when database file does not exist", async () => {
    const nonExistentPath = path.join(tmpDir, "missing", "db.sqlite")
    const recovery = await makeRecoveryService(nonExistentPath)
    const res = await Effect.runPromise(recovery.healSession("sess_test"))
    expect(res.checked).toBe(false)
    expect(res.healedCount).toBe(0)
    expect(res.healedParts.length).toBe(0)
  })

  test("skips healing when fs.exists fails with platform error", async () => {
    const fakeFs = {
      exists: () => Effect.fail(new Error("EACCES"))
    } as unknown as FileSystem
    const service = await Effect.runPromise(
      SessionRecovery.pipe(
        Effect.provide(SessionRecovery.layerNoDeps),
        Effect.provideService(FileSystem, fakeFs),
        Effect.provide(Log.layerQuiet)
      )
    )
    const res = await Effect.runPromise(service.healSession("sess_test"))
    expect(res.checked).toBe(false)
    expect(res.healedCount).toBe(0)
  })

  test("returns checked=true and 0 healed when no pending tool parts exist", async () => {
    const db = createTestDb()
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "part_1",
        "msg_1",
        "sess_1",
        1000,
        1000,
        JSON.stringify({
          type: "tool",
          callID: "call_ok",
          tool: "Bash",
          state: { status: "completed", input: { command: "ls" }, output: "file.txt" }
        })
      ]
    )
    db.close()

    const recovery = await makeRecoveryService()
    const res = await Effect.runPromise(recovery.healSession("sess_1"))
    expect(res.checked).toBe(true)
    expect(res.healedCount).toBe(0)
    expect(res.healedParts.length).toBe(0)
  })

  test("heals pending tool part to error status and preserves input", async () => {
    const db = createTestDb()
    const inputPayload = { todos: [{ content: "do work", status: "pending" }] }
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "part_pending",
        "msg_1",
        "sess_target",
        1000,
        1000,
        JSON.stringify({
          type: "tool",
          callID: "call_todo_123",
          tool: "TodoWrite",
          state: { status: "pending", input: inputPayload, time: { start: 1000 } }
        })
      ]
    )
    // Add another part for a different session that is also pending
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "part_other",
        "msg_2",
        "sess_other",
        1000,
        1000,
        JSON.stringify({
          type: "tool",
          callID: "call_other",
          tool: "Bash",
          state: { status: "pending", input: { command: "pwd" } }
        })
      ]
    )
    db.close()

    const recovery = await makeRecoveryService()
    const res = await Effect.runPromise(recovery.healSession("sess_target"))
    expect(res.checked).toBe(true)
    expect(res.healedCount).toBe(1)
    expect(res.healedParts).toEqual([
      {
        id: "part_pending",
        callId: "call_todo_123",
        tool: "TodoWrite"
      }
    ])

    // Verify row was updated in SQLite
    const verifyDb = new Database(dbPath, { readonly: true })
    const healedRow = verifyDb
      .query<{ data: string; time_updated: number }, [string]>("SELECT data, time_updated FROM part WHERE id = ?")
      .get("part_pending")
    expect(healedRow).toBeDefined()
    expect(healedRow!.time_updated).toBeGreaterThan(1000)

    const parsed = JSON.parse(healedRow!.data)
    expect(parsed.state.status).toBe("error")
    expect(parsed.state.error).toContain("[Bridge Auto-Recovery]")
    expect(parsed.state.input).toEqual(inputPayload)
    expect(parsed.state.time.start).toBe(1000)
    expect(parsed.state.time.end).toBeGreaterThanOrEqual(1000)

    // Verify other session was untouched
    const otherRow = verifyDb.query<{ data: string }, [string]>("SELECT data FROM part WHERE id = ?").get("part_other")
    expect(JSON.parse(otherRow!.data).state.status).toBe("pending")

    verifyDb.close()
  })

  test("handles malformed JSON in part table gracefully", async () => {
    const db = createTestDb()
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["part_bad", "msg_1", "sess_bad", 1000, 1000, '{"type":"tool", "status":"pending" INVALID_JSON']
    )
    db.close()

    const recovery = await makeRecoveryService()
    const res = await Effect.runPromise(recovery.healSession("sess_bad"))
    expect(res.checked).toBe(true)
    expect(res.healedCount).toBe(0)
  })

  test("fails with RecoveryError when database schema is invalid or query fails", async () => {
    // Create invalid table (missing part table)
    const db = new Database(dbPath, { create: true })
    db.run("CREATE TABLE wrong_table (id TEXT);")
    db.close()

    const recovery = await makeRecoveryService()
    const exit = await Effect.runPromiseExit(recovery.healSession("sess_err"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = exit.cause
      expect(String(err)).toContain("RecoveryError")
    }
  })

  test("defaultDbPath respects ZCODE_DATA_BASE_DIR override", () => {
    const original = process.env.ZCODE_DATA_BASE_DIR
    try {
      process.env.ZCODE_DATA_BASE_DIR = "/custom/zcode/data"
      const p = defaultDbPath()
      expect(p).toBe("/custom/zcode/data/.zcode/cli/db/db.sqlite")
    } finally {
      if (original !== undefined) process.env.ZCODE_DATA_BASE_DIR = original
      else delete process.env.ZCODE_DATA_BASE_DIR
    }
  })

  test("layerNoDeps constructs a functioning service from environment layers", async () => {
    createTestDb().close()
    const original = process.env.ZCODE_DATA_BASE_DIR
    try {
      process.env.ZCODE_DATA_BASE_DIR = tmpDir
      // create dir structure matching dataRoot() / .zcode / cli / db / db.sqlite
      const nested = path.join(tmpDir, ".zcode", "cli", "db")
      fs.mkdirSync(nested, { recursive: true })
      fs.copyFileSync(dbPath, path.join(nested, "db.sqlite"))

      const service = await Effect.runPromise(
        SessionRecovery.pipe(
          Effect.provide(SessionRecovery.layerNoDeps),
          Effect.provide(BunFileSystem.layer),
          Effect.provide(Log.layerQuiet)
        )
      )
      const res = await Effect.runPromise(service.healSession("test_session"))
      expect(res.checked).toBe(true)
      expect(res.healedCount).toBe(0)
    } finally {
      if (original !== undefined) process.env.ZCODE_DATA_BASE_DIR = original
      else delete process.env.ZCODE_DATA_BASE_DIR
    }
  })

  test("make constructs a functioning service with custom db path", async () => {
    createTestDb().close()
    const service = await Effect.runPromise(
      SessionRecovery.pipe(
        Effect.provide(SessionRecovery.make(dbPath)),
        Effect.provide(BunFileSystem.layer),
        Effect.provide(Log.layerQuiet)
      )
    )
    const res = await Effect.runPromise(service.healSession("test_session"))
    expect(res.checked).toBe(true)
    expect(res.healedCount).toBe(0)
  })
})

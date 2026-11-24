/**
 * Bun driver for the `Sqlite` port — the one module under src/ that imports
 * `bun:sqlite` (ADR 0002: builtins are reached through a platform layer, never
 * imported by the service that uses them). `bin.ts` provides it.
 */
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { SqliteError, renderError } from "../errors.ts"
import { Sqlite, type SqliteConnection, type SqliteValue } from "./sqlite.ts"

const codeOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "UNKNOWN"

const connect = (db: Database): SqliteConnection => ({
  all: <A>(sql: string, ...params: SqliteValue[]): Array<A> => db.prepare(sql).all(...params) as Array<A>,
  run: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
  // The driver's own wrapper rolls back when `fn` throws.
  transaction: (fn) => db.transaction(fn).immediate()
})

const withConnection = <A>(
  path: string,
  busyTimeoutMs: number,
  fn: (db: SqliteConnection) => A
): Effect.Effect<A, SqliteError> =>
  Effect.try({
    try: () => {
      const db = new Database(path, { create: false, readwrite: true })
      try {
        // An interpolated integer in a PRAGMA: statements cannot bind it.
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`)
        return fn(connect(db))
      } finally {
        db.close()
      }
    },
    catch: (cause) => new SqliteError({ path, code: codeOf(cause), message: renderError(cause) })
  })

export const BunSqlite = {
  layer: Layer.succeed(Sqlite, Sqlite.of({ withConnection }))
}

/**
 * `Sqlite` — port to a SQLite database file.
 *
 * The daemon's conversation store is one, and AGENTS.md keeps Bun builtins out
 * of domain code: a service depends on this interface only, and the Bun driver
 * (`sqlite-bun.ts`) is provided by `bin.ts`'s platform layer.
 */
import { Context, Effect } from "effect"
import { SqliteError } from "../errors.ts"

/** Value a statement can bind: text, integer, or NULL. */
export type SqliteValue = string | number | null

/** One read/write connection to a SQLite database file. Statements are plain SQL with `?` placeholders. */
export interface SqliteConnection {
  /** Every row of a read statement. */
  all<A>(sql: string, ...params: SqliteValue[]): Array<A>
  /** A write statement; resolves to the number of rows it changed. */
  run(sql: string, ...params: SqliteValue[]): number
  /**
   * `fn` inside one `BEGIN IMMEDIATE` transaction: the write lock is taken up
   * front, so nothing another process writes can land between a read and the
   * write that depends on it. A throw rolls back and rethrows.
   */
  transaction<A>(fn: () => A): A
}

export class Sqlite extends Context.Service<
  Sqlite,
  {
    /**
     * Opens `path` read/write (`create: false`), waits at most `busyTimeoutMs`
     * for a write lock another process holds, runs `fn`, and always closes the
     * connection. Driver failures surface as `SqliteError`.
     */
    readonly withConnection: <A>(
      path: string,
      busyTimeoutMs: number,
      fn: (db: SqliteConnection) => A
    ) => Effect.Effect<A, SqliteError>
  }
>()("zcode-serve-acp/Sqlite") {}

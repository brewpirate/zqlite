/**
 * Result returned by `.run()` on a prepared write statement. Matches the
 * native shape of `bun:sqlite`, `better-sqlite3`, and Node 22's `node:sqlite`
 * — `lastInsertRowid` is `bigint` under drivers configured for `safeIntegers`
 * and `number` otherwise, so the union covers both modes.
 *
 * Surfaced through {@link SqliteStatement.run} so `defineWrite` can return
 * affected-row counts and inserted IDs without the read-shaped detour
 * `defineQuery({…, result: z.object({}) })` used to require.
 */
export interface SqliteRunResult {
  /** Number of rows affected by the statement (driver-reported). */
  changes: number
  /**
   * Row ID of the most recent INSERT on this connection, or 0 for non-INSERT
   * statements. `bigint` under drivers configured for `safeIntegers`.
   */
  lastInsertRowid: number | bigint
}

/**
 * The subset of a prepared statement that zqlite requires. Satisfied by
 * `bun:sqlite`, `better-sqlite3`, and `node:sqlite` (StatementSync) without
 * any wrapper code.
 *
 * Params are typed as `unknown` to avoid function-parameter contravariance
 * failures when comparing driver signatures — type safety is enforced upstream
 * by Zod validation and {@link serializeRow} before values reach the driver.
 */
export interface SqliteStatement {
  /** Returns the first matching row, or `null` / `undefined` if none. */
  get(...parameters: unknown[]): unknown
  /** Returns all matching rows. */
  all(...parameters: unknown[]): unknown[]
  /**
   * Executes a write statement (INSERT / UPDATE / DELETE / DDL) and returns
   * the driver-reported `{ changes, lastInsertRowid }`. Callers that don't
   * need the result can ignore the return value — every supported driver
   * still produces it.
   */
  run(...parameters: unknown[]): SqliteRunResult
}

/**
 * The subset of a SQLite database connection that zqlite requires. Intentionally
 * narrow so the library is not coupled to any specific driver.
 *
 * `bun:sqlite`'s `Database`, `better-sqlite3`'s `Database`, and Node 22's
 * `DatabaseSync` all satisfy this interface — pass the native connection
 * directly without a wrapper.
 *
 * @example
 * ```ts
 * // bun:sqlite
 * import { Database } from 'bun:sqlite'
 * const db: SqliteAdapter = new Database('app.db')
 *
 * // better-sqlite3
 * import Database from 'better-sqlite3'
 * const db: SqliteAdapter = new Database('app.db')
 * ```
 */
export interface SqliteAdapter {
  /**
   * Compiles a SQL statement and returns a reusable prepared statement.
   * Pass `$param` named placeholders in the SQL; bind values via the returned
   * statement's methods.
   */
  prepare(sql: string): SqliteStatement
  /**
   * Wraps a synchronous function in a database transaction. The returned
   * function commits on success and rolls back on throw. Matches the API
   * of `bun:sqlite` and `better-sqlite3`.
   */
  transaction<CallbackResult>(
    callback: () => CallbackResult,
  ): () => CallbackResult
  /**
   * Prefix applied to each param key before binding named parameters.
   *
   * `bun:sqlite` requires `'$'` (default) — i.e. `{ $name: value }` for a
   * `$name` placeholder. `better-sqlite3` requires `''` — i.e. `{ name: value }`.
   * Omit to use the default `'$'`.
   */
  paramPrefix?: string
}

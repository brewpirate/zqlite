import type { z } from 'zod'
import { prefixParamKeys } from './internal'
import { serializeRow } from './serialize'
import { execWrite } from './transaction'
import type { SqliteAdapter, SqliteRunResult } from './types'

/**
 * Options for {@link defineWrite}. Mirrors `DefineQueryOptions` but omits the
 * row-result schema because writes do not return rows — they return
 * `{ changes, lastInsertRowid }` instead.
 *
 * `ParamsSchema` is constrained to `z.ZodObject` so params keys map cleanly
 * onto named SQL placeholders. A scalar params schema would bind every
 * `$param` to NULL at runtime — the type bound rules that out at the type
 * level (same rule as `defineQuery`).
 */
export interface DefineWriteOptions<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
> {
  /** The SQLite database connection to prepare the statement against. */
  db: SqliteAdapter
  /** Zod schema for query parameters — validated before binding. */
  params: ParamsSchema
  /** The SQL statement. Use `$param` named placeholders matching `params` keys. */
  sql: string
}

/**
 * The shape returned by every write — both `.run` and `.runInTransaction`. Mirrors the
 * native return of `bun:sqlite`, `better-sqlite3`, and Node's `node:sqlite`.
 *
 * Re-exported from `./types` (where `SqliteRunResult` lives as part of the
 * adapter surface) so callers importing `WriteResult` see the same fields.
 */
export type WriteResult = SqliteRunResult

/**
 * The handle returned by {@link defineWrite}. Each method validates and
 * serializes params before binding, then returns the driver-reported
 * `{ changes, lastInsertRowid }` after executing the statement.
 *
 * `.run` executes the statement outside any transaction. `.runInTransaction`
 * wraps the single statement in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` —
 * use it when a single-statement write previously needed
 * `execWrite(db, () => writeHandle.run(…))`. Multi-statement writes still
 * belong inside an explicit `execWrite` block; `.runInTransaction` cannot
 * batch siblings.
 */
export interface WriteHandle<ParamsSchema extends z.ZodObject<z.ZodRawShape>> {
  /** Executes the statement and returns the driver-reported result. */
  run(params: z.infer<ParamsSchema>): WriteResult
  /**
   * Wraps a single execution in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
   * On callback throw, attempts rollback; if rollback itself fails, throws
   * `TransactionRollbackError` carrying both the trigger and the rollback
   * failure (same semantics as `execWrite`).
   */
  runInTransaction(params: z.infer<ParamsSchema>): WriteResult
}

/**
 * Defines a type-safe SQLite write with Zod validation on the params boundary.
 *
 * The statement is compiled once at call time via `db.prepare()`. Each
 * returned method validates and serializes params before binding, then
 * executes the statement and returns the driver-reported result
 * (`{ changes, lastInsertRowid }`).
 *
 * Use this in place of `defineQuery({…, result: z.object({}) })` for any
 * INSERT / UPDATE / DELETE / DDL statement. Writes were previously forced
 * through the read-shaped `defineQuery` API because no write-shaped primitive
 * existed; that placeholder result schema is the friction this primitive
 * removes (per the deepening pass that introduced `defineWrite`).
 *
 * @param options.db - Database to prepare the statement against
 * @param options.params - Schema for query parameters; validated before binding
 * @param options.sql - SQL with `$param` named placeholders
 *
 * @returns An object with `.run()` and `.runInTransaction()` methods bound to the
 * prepared statement. Pass `db` to this function, not to the methods.
 */
export function defineWrite<ParamsSchema extends z.ZodObject<z.ZodRawShape>>(
  options: DefineWriteOptions<ParamsSchema>,
): WriteHandle<ParamsSchema> {
  const { db, params: paramSchema, sql } = options
  const statement = db.prepare(sql)
  const paramPrefix = db.paramPrefix ?? '$'

  function executeRun(params: z.infer<ParamsSchema>): WriteResult {
    const parsed = paramSchema.parse(params) as Record<string, unknown>
    const serialized = prefixParamKeys(serializeRow(parsed), paramPrefix)
    return statement.run(serialized)
  }

  return {
    run: (params: z.infer<ParamsSchema>): WriteResult => executeRun(params),
    runInTransaction: (params: z.infer<ParamsSchema>): WriteResult =>
      execWrite(db, () => executeRun(params)),
  }
}

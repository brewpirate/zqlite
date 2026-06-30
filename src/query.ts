import type { z } from 'zod'
import { QueryValidationError } from './errors'
import { buildRowCoercer, prefixParamKeys } from './internal'
import { serializeRow } from './serialize'
import type { SqliteAdapter } from './types'

/**
 * Options for {@link defineQuery}. Binds the database connection and schemas
 * at definition time so the SQL is compiled once and reused across calls.
 *
 * `ParamsSchema` is constrained to `z.ZodObject` so params keys map cleanly
 * onto named SQL placeholders. A scalar params schema (`z.string()`,
 * `z.number()`, …) compiled here would silently bind every `$param` to NULL
 * at runtime — the type bound rules that out at the type level.
 */
export interface DefineQueryOptions<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
> {
  /** The SQLite database connection to prepare the statement against. */
  db: SqliteAdapter
  /** Zod schema for query parameters — validated before binding. */
  params: ParamsSchema
  /** Zod schema for result rows — validated and coerced after fetching. */
  result: ResultSchema
  /** The SQL statement. Use `$param` named placeholders matching `params` keys. */
  sql: string
}

/**
 * The handle returned by {@link defineQuery}. Each method validates and
 * serializes params before binding, then coerces and validates results
 * after fetching.
 */
export interface QueryHandle<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
> {
  /** Fetches a single row, or `null` if no row matches. */
  one(params: z.infer<ParamsSchema>): z.infer<ResultSchema> | null
  /** Fetches all matching rows. Returns an empty array if none match. */
  all(params: z.infer<ParamsSchema>): z.infer<ResultSchema>[]
  /** Executes a write statement (INSERT, UPDATE, DELETE). */
  run(params: z.infer<ParamsSchema>): void
}

/**
 * Defines a type-safe SQLite query with Zod validation on both boundaries.
 *
 * The statement is compiled once at call time via `db.prepare()`. Each
 * returned method validates and serializes params before binding, then
 * coerces and validates results after fetching — catching type mismatches at
 * the DB boundary rather than silently propagating wrong values.
 *
 * @param options.db - Database to prepare the statement against
 * @param options.params - Schema for query parameters; validated before binding
 * @param options.result - Schema for result rows; coerced then validated after fetch
 * @param options.sql - SQL with `$param` named placeholders
 *
 * @returns An object with `.one()`, `.all()`, and `.run()` methods bound to
 * the prepared statement. Pass `db` to this function, not to the methods.
 */
export function defineQuery<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
>(
  options: DefineQueryOptions<ParamsSchema, ResultSchema>,
): QueryHandle<ParamsSchema, ResultSchema> {
  const { db, params: paramSchema, result: resultSchema, sql } = options
  const statement = db.prepare(sql)
  const coerceRow = buildRowCoercer(resultSchema)
  const paramPrefix = db.paramPrefix ?? '$'

  function parseResult(row: unknown, rowIndex?: number): z.infer<ResultSchema> {
    const coerced = coerceRow(row as Record<string, unknown>)
    try {
      return resultSchema.parse(coerced)
    } catch (cause) {
      throw new QueryValidationError({ sql, rowIndex, cause })
    }
  }

  return {
    /** Fetches a single row, or `null` if no row matches. */
    one: (params: z.infer<ParamsSchema>): z.infer<ResultSchema> | null => {
      const parsed = paramSchema.parse(params) as Record<string, unknown>
      const serialized = prefixParamKeys(serializeRow(parsed), paramPrefix)
      const row = statement.get(serialized)
      return row ? parseResult(row) : null
    },
    /** Fetches all matching rows. Returns an empty array if none match. */
    all: (params: z.infer<ParamsSchema>): z.infer<ResultSchema>[] => {
      const parsed = paramSchema.parse(params) as Record<string, unknown>
      const serialized = prefixParamKeys(serializeRow(parsed), paramPrefix)
      const rows = statement.all(serialized)
      return rows.map((row, rowIndex) => parseResult(row, rowIndex))
    },
    /** Executes a write statement (INSERT, UPDATE, DELETE). */
    run: (params: z.infer<ParamsSchema>): void => {
      const parsed = paramSchema.parse(params) as Record<string, unknown>
      const serialized = prefixParamKeys(serializeRow(parsed), paramPrefix)
      statement.run(serialized)
    },
  }
}

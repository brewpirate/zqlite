import type { z } from 'zod'
import { QueryValidationError } from './errors.js'
import { buildRowCoercer, prefixParamKeys } from './internal.js'
import { assertStaticPlaceholders } from './placeholders.js'
import { serializeRow } from './serialize.js'

/**
 * The async counterpart to {@link import('./types.js').SqliteAdapter}, for
 * drivers whose I/O is asynchronous — chiefly `@libsql/client` talking to a
 * remote Turso database over HTTP.
 *
 * It is deliberately a *separate* surface, not a replacement: the synchronous
 * drivers (`bun:sqlite`, `better-sqlite3`, `node:sqlite`, local `libsql`) keep
 * their synchronous API and are not burdened with Promises they don't need.
 * Both surfaces share the same validation core (param serialization, row
 * coercion, result validation) — only the one I/O call differs.
 *
 * The interface is intentionally narrower and simpler than `SqliteAdapter`: an
 * async client is execute-per-call, so there is no prepared-statement handle to
 * model. `@libsql/client`'s `Client` satisfies this interface directly — pass
 * it without a wrapper.
 */
export interface AsyncSqliteAdapter extends AsyncExecutor {
  /**
   * Opens an interactive transaction. Writes issued through the returned
   * {@link AsyncTransaction} are atomic: they commit together or roll back
   * together. `@libsql/client`'s `transaction('write')` satisfies this.
   *
   * `execWriteAsync` uses this rather than issuing separate `BEGIN` / `COMMIT`
   * statements — over a remote client, independent awaited calls do not share a
   * transaction context, so an interactive transaction object is required.
   */
  transaction(mode: 'write'): Promise<AsyncTransaction>
}

/**
 * Anything that can execute a single statement asynchronously — both the
 * connection ({@link AsyncSqliteAdapter}) and an open {@link AsyncTransaction}.
 * The write/query handles accept an `AsyncExecutor` so the same handle can run
 * standalone (against the connection) or inside a transaction (against the tx).
 */
export interface AsyncExecutor {
  /**
   * Runs one statement. `sql` uses `$name` placeholders; `args` binds them by
   * bare key (`{ name: value }`). Returns the fetched rows plus the write
   * counters. Matches `@libsql/client`'s `execute({ sql, args })`.
   */
  execute(statement: {
    sql: string
    args: Record<string, unknown>
  }): Promise<AsyncResultSet>
}

/**
 * An open interactive transaction. `@libsql/client`'s `Transaction` satisfies
 * this. Always `commit()` or `rollback()` exactly once — `execWriteAsync`
 * handles that for you.
 */
export interface AsyncTransaction extends AsyncExecutor {
  /** Commits every statement executed on this transaction. */
  commit(): Promise<void>
  /** Discards every statement executed on this transaction. */
  rollback(): Promise<void>
}

/**
 * The result of one async execution — the subset zqlite needs from a driver's
 * result set. `@libsql/client`'s `ResultSet` satisfies it.
 */
export interface AsyncResultSet {
  /** Result rows as plain `{ column: value }` objects. */
  rows: unknown[]
  /** Number of rows the statement changed (INSERT / UPDATE / DELETE). */
  rowsAffected: number
  /** Row id of the last INSERT, when the driver reports one. */
  lastInsertRowid?: bigint
}

/**
 * The result of an async write — mirrors the synchronous `SqliteRunResult` so
 * the two surfaces report writes the same way. `lastInsertRowid` is `0` when the
 * driver did not report one (e.g. a non-INSERT statement).
 */
export interface AsyncWriteResult {
  /** Rows changed by the statement. */
  changes: number
  /** Row id of the most recent INSERT, or `0`. */
  lastInsertRowid: number | bigint
}

/** Options for {@link defineAsyncQuery}. Mirrors the synchronous `defineQuery`. */
export interface DefineAsyncQueryOptions<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
> {
  /** The async database connection to run the statement against. */
  db: AsyncSqliteAdapter
  /** Schema for query parameters — validated before binding. */
  params: ParamsSchema
  /** Schema for result rows — coerced then validated after fetching. */
  result: ResultSchema
  /** SQL with `$name` placeholders matching `params` keys. */
  sql: string
  /**
   * Skip the define-time cross-check that every `$name` placeholder in `sql`
   * has a matching key in `params`. Off by default; set only when the SQL is
   * built in a way the static check cannot follow.
   */
  skipPlaceholderCheck?: boolean
}

/**
 * The handle returned by {@link defineAsyncQuery}. Each method validates and
 * serializes params before binding, then coerces and validates rows after
 * fetching — the same core as the synchronous handle, awaited.
 */
export interface AsyncQueryHandle<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
> {
  /** Fetches a single row, or `null` if none matched. */
  one(
    params: z.infer<ParamsSchema>,
    executor?: AsyncExecutor,
  ): Promise<z.infer<ResultSchema> | null>
  /** Fetches all matching rows; empty array if none matched. */
  all(
    params: z.infer<ParamsSchema>,
    executor?: AsyncExecutor,
  ): Promise<z.infer<ResultSchema>[]>
}

/** Options for {@link defineAsyncWrite}. Mirrors the synchronous `defineWrite`. */
export interface DefineAsyncWriteOptions<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
> {
  /** The async database connection to run the statement against. */
  db: AsyncSqliteAdapter
  /** Schema for write parameters — validated before binding. */
  params: ParamsSchema
  /** SQL with `$name` placeholders matching `params` keys. */
  sql: string
  /** See {@link DefineAsyncQueryOptions.skipPlaceholderCheck}. */
  skipPlaceholderCheck?: boolean
}

/** The handle returned by {@link defineAsyncWrite}. */
export interface AsyncWriteHandle<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
> {
  /**
   * Executes the write and resolves to the driver-reported result. Pass an
   * `executor` (an open {@link AsyncTransaction}) to run the write inside a
   * transaction — this is how write handles compose with {@link execWriteAsync}.
   * Omit it to run against the connection the handle was defined with.
   */
  run(
    params: z.infer<ParamsSchema>,
    executor?: AsyncExecutor,
  ): Promise<AsyncWriteResult>
}

/**
 * Serializes validated params into bind args. The prefix is `''` (bare keys):
 * `@libsql/client` binds `$name` placeholders from `{ name: value }`, so no
 * prefix is applied. Same `serializeRow` + `prefixParamKeys` the sync path uses.
 */
function toAsyncArgs(
  paramSchema: z.ZodObject<z.ZodRawShape>,
  params: unknown,
): Record<string, unknown> {
  const parsed = paramSchema.parse(params) as Record<string, unknown>
  return prefixParamKeys(serializeRow(parsed), '')
}

/**
 * The async counterpart to `defineQuery`: a type-safe query over an
 * {@link AsyncSqliteAdapter}, with Zod validation on both boundaries.
 *
 * The logic is identical to the synchronous handle — validate and serialize
 * params, run the statement, coerce and validate rows — with a single `await`
 * on the one asynchronous I/O call. The coercion and validation are the shared,
 * synchronous core, so booleans, `Date`s, and JSON columns round-trip exactly as
 * they do on the synchronous drivers.
 *
 * @param options.db - Async database to run the statement against
 * @param options.params - Schema for query parameters; validated before binding
 * @param options.result - Schema for result rows; coerced then validated after fetch
 * @param options.sql - SQL with `$name` placeholders
 * @returns An object with async `.one()` and `.all()` methods
 */
export function defineAsyncQuery<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
>(
  options: DefineAsyncQueryOptions<ParamsSchema, ResultSchema>,
): AsyncQueryHandle<ParamsSchema, ResultSchema> {
  const { db, params: paramSchema, result: resultSchema, sql } = options
  assertStaticPlaceholders(sql, paramSchema, options.skipPlaceholderCheck)
  const coerceRow = buildRowCoercer(resultSchema)

  function parseResult(row: unknown, rowIndex?: number): z.infer<ResultSchema> {
    const coerced = coerceRow(row as Record<string, unknown>)
    try {
      return resultSchema.parse(coerced)
    } catch (cause) {
      throw new QueryValidationError({ sql, rowIndex, cause })
    }
  }

  return {
    async one(
      params: z.infer<ParamsSchema>,
      executor: AsyncExecutor = db,
    ): Promise<z.infer<ResultSchema> | null> {
      const args = toAsyncArgs(paramSchema, params)
      const resultSet = await executor.execute({ sql, args })
      const firstRow = resultSet.rows[0]
      return firstRow === undefined ? null : parseResult(firstRow)
    },
    async all(
      params: z.infer<ParamsSchema>,
      executor: AsyncExecutor = db,
    ): Promise<z.infer<ResultSchema>[]> {
      const args = toAsyncArgs(paramSchema, params)
      const resultSet = await executor.execute({ sql, args })
      return resultSet.rows.map((row, rowIndex) => parseResult(row, rowIndex))
    },
  }
}

/**
 * The async counterpart to `defineWrite`: a type-safe INSERT / UPDATE / DELETE
 * over an {@link AsyncSqliteAdapter}, validating params before binding and
 * returning the driver-reported `{ changes, lastInsertRowid }`.
 *
 * @param options.db - Async database to run the statement against
 * @param options.params - Schema for write parameters; validated before binding
 * @param options.sql - SQL with `$name` placeholders
 * @returns An object with an async `.run()` method that accepts an optional
 *   transaction executor
 */
export function defineAsyncWrite<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
>(
  options: DefineAsyncWriteOptions<ParamsSchema>,
): AsyncWriteHandle<ParamsSchema> {
  const { db, params: paramSchema, sql } = options
  assertStaticPlaceholders(sql, paramSchema, options.skipPlaceholderCheck)

  return {
    async run(
      params: z.infer<ParamsSchema>,
      executor: AsyncExecutor = db,
    ): Promise<AsyncWriteResult> {
      const args = toAsyncArgs(paramSchema, params)
      const resultSet = await executor.execute({ sql, args })
      return {
        changes: resultSet.rowsAffected,
        lastInsertRowid: resultSet.lastInsertRowid ?? 0,
      }
    },
  }
}

/**
 * The async counterpart to `execWrite`: runs `operations` inside a single
 * interactive transaction, committing on success and rolling back on throw.
 *
 * Unlike the synchronous `execWrite` — which issues `BEGIN IMMEDIATE` / `COMMIT`
 * / `ROLLBACK` as separate statements on one connection — the async version
 * opens an {@link AsyncTransaction} and passes it to `operations`. Run write
 * handles against it via their `executor` argument:
 *
 * ```ts
 * await execWriteAsync(db, async (tx) => {
 *   await lendBook.run({ book_id: 'bk_1' }, tx)
 *   await logActivity.run({ detail: 'lent bk_1' }, tx)
 * })
 * ```
 *
 * This is required because, over a remote client, independent awaited calls do
 * not share a transaction context — the atomic unit is the transaction object,
 * not the connection.
 *
 * Note on latency: an interactive transaction is a network round-trip per
 * statement. For a batch of writes that don't read between them, a driver-level
 * `batch()` (one round-trip) is cheaper; reach for `execWriteAsync` when you
 * need read-your-writes or conditional logic between statements.
 *
 * @param db - The async database connection
 * @param operations - Async work to run atomically; receives the open transaction
 * @returns The value `operations` resolves to
 * @throws Re-throws the callback's error after rolling back
 */
export async function execWriteAsync<CallbackResult>(
  db: AsyncSqliteAdapter,
  operations: (transaction: AsyncTransaction) => Promise<CallbackResult>,
): Promise<CallbackResult> {
  const transaction = await db.transaction('write')
  try {
    const result = await operations(transaction)
    await transaction.commit()
    return result
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}

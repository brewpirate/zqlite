import type { z } from 'zod'
import { QueryValidationError } from './errors.js'
import { buildRowCoercer, prefixParamKeys } from './internal.js'
import { assertDynamicPlaceholders } from './placeholders.js'
import { serializeRow } from './serialize.js'
import type { SqliteAdapter, SqliteStatement } from './types.js'

/**
 * Options for {@link defineDynamicQuery}. Composes a base SELECT with
 * optional named `WHERE` fragments and a named `ORDER BY` selector, then
 * caches the resulting prepared statement per fragment combination.
 *
 * Activation is **explicit**, not param-derived. Callers pass
 * `where: ['cwd', 'from']` to say "this query should filter by both today";
 * passing `params.cwd: null` does NOT drop the predicate. The previous
 * idiom (`WHERE ($cwd IS NULL OR cwd = $cwd)`) defeats covering indexes
 * because the planner can't fold the constant — explicit activation lets
 * the optimizer see a real, prunable clause.
 *
 * `ParamsSchema` is constrained to `z.ZodObject` for the same reason as
 * `defineQuery`: scalar params silently bind every `$param` to NULL at runtime.
 */
export interface DefineDynamicQueryOptions<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
  WhereKey extends string,
  OrderKey extends string,
> {
  /** The SQLite database connection to prepare statements against. */
  db: SqliteAdapter
  /** Zod schema for query parameters — validated before binding. */
  params: ParamsSchema
  /** Zod schema for result rows — validated and coerced after fetching. */
  result: ResultSchema
  /**
   * Base SELECT statement WITHOUT trailing `WHERE` / `ORDER BY`. May contain
   * `FROM`, `JOIN`, `GROUP BY`, etc. — anything that doesn't vary with the
   * predicate set. The composer appends `WHERE …` and `ORDER BY …` clauses.
   */
  sql: string
  /**
   * Named predicate fragments. Each entry is a SQL snippet (without leading
   * `WHERE` / `AND`) using `$param` placeholders from {@link params}. Active
   * fragments are AND-joined; inactive ones are omitted entirely.
   */
  where?: Record<WhereKey, string>
  /**
   * Named ORDER BY clauses. Each entry is the body of an ORDER BY (e.g.
   * `'total_tokens DESC'`). Only one entry can be active per query.
   */
  order?: Record<OrderKey, string>
  /**
   * Bypass the definition-time SQL/params cross-check. See
   * {@link DefineQueryOptions.skipPlaceholderCheck}. For dynamic queries the
   * check validates the union of placeholders across the base SQL and every
   * `where` / `order` fragment.
   */
  skipPlaceholderCheck?: boolean
}

/**
 * Handle returned by {@link defineDynamicQuery}. Statement preparation is
 * lazy: the first call with a given `(where, orderBy)` shape compiles the
 * statement; subsequent calls hit the cache.
 */
export interface DynamicQueryHandle<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
  WhereKey extends string,
  OrderKey extends string,
> {
  /** Fetches a single row, or `null` if no row matches. */
  one(opts: {
    params: z.infer<ParamsSchema>
    where?: readonly WhereKey[]
    orderBy?: OrderKey
  }): z.infer<ResultSchema> | null
  /** Fetches all matching rows. Returns an empty array if none match. */
  all(opts: {
    params: z.infer<ParamsSchema>
    where?: readonly WhereKey[]
    orderBy?: OrderKey
  }): z.infer<ResultSchema>[]
}

/**
 * Cache key for the prepared-statement cache. Sorting the `where` keys means
 * `['cwd', 'from']` and `['from', 'cwd']` produce the same SQL and share the
 * cached statement. `::` separates the where-set from the order alias so the
 * two namespaces can't collide on a stray pipe character.
 */
function cacheKey(
  activeWhere: readonly string[],
  orderBy: string | undefined,
): string {
  return `${[...activeWhere].sort().join('|')}::${orderBy ?? ''}`
}

/**
 * Composes a type-safe SQLite query whose `WHERE` and `ORDER BY` shape varies
 * by call. Replaces both the "N hand-rolled handles per filter combination"
 * pattern (`listSkillsAll` / `listSkillsByEnv` / …) and the index-defeating
 * `WHERE ($x IS NULL OR col = $x)` SQL idiom.
 *
 * Each unique `(where, orderBy)` shape compiles one prepared statement, cached
 * by the sorted fragment signature. The cache lives as long as the handle —
 * scope it to a router factory or module init for process-long reuse.
 *
 * @param options.db - Database to prepare statements against
 * @param options.params - Schema for query parameters; validated before binding
 * @param options.result - Schema for result rows; coerced then validated after fetch
 * @param options.sql - Base SELECT without WHERE / ORDER BY
 * @param options.where - Named predicate fragments AND-joined when active
 * @param options.order - Named ORDER BY clauses, mutually exclusive
 *
 * @returns An object with `.one()` and `.all()` methods. Pass the active
 * fragment keys and the order alias at call time; SQL composition is lazy
 * and cached.
 */
export function defineDynamicQuery<
  ParamsSchema extends z.ZodObject<z.ZodRawShape>,
  ResultSchema extends z.ZodType,
  WhereKey extends string = never,
  OrderKey extends string = never,
>(
  options: DefineDynamicQueryOptions<
    ParamsSchema,
    ResultSchema,
    WhereKey,
    OrderKey
  >,
): DynamicQueryHandle<ParamsSchema, ResultSchema, WhereKey, OrderKey> {
  const {
    db,
    params: paramSchema,
    result: resultSchema,
    sql: baseSql,
    where = {} as Record<WhereKey, string>,
    order = {} as Record<OrderKey, string>,
  } = options
  // `Object.values` on a generic `Record<Key, string>` widens to `unknown[]`
  // (the finite-key Record doesn't match the string-index-signature overload),
  // so the values are asserted back to their declared `string` element type.
  const whereFragments = Object.values(where) as string[]
  const orderFragments = Object.values(order) as string[]
  assertDynamicPlaceholders(
    baseSql,
    [...whereFragments, ...orderFragments],
    paramSchema,
    options.skipPlaceholderCheck,
  )
  const coerceRow = buildRowCoercer(resultSchema)
  const paramPrefix = db.paramPrefix ?? '$'
  const statementCache = new Map<string, SqliteStatement>()

  /**
   * Returns the prepared statement for a given `(where, orderBy)` shape,
   * compiling it on first use and caching by the sorted fragment signature.
   * Composition is deferred to call time rather than done up front so each
   * distinct fragment combination pays the `db.prepare()` cost exactly once.
   */
  function getStatement(
    activeWhere: readonly WhereKey[],
    orderBy: OrderKey | undefined,
  ): SqliteStatement {
    const signature = cacheKey(activeWhere, orderBy)
    const cached = statementCache.get(signature)
    if (cached) return cached

    let fullSql = baseSql
    if (activeWhere.length > 0) {
      const clauses = activeWhere.map((fragmentKey) => where[fragmentKey])
      fullSql += ` WHERE ${clauses.join(' AND ')}`
    }
    if (orderBy !== undefined && order[orderBy] !== undefined) {
      fullSql += ` ORDER BY ${order[orderBy]}`
    }

    const statement = db.prepare(fullSql)
    statementCache.set(signature, statement)
    return statement
  }

  /**
   * Coerces then Zod-validates a single result row, wrapping any validation
   * failure in a {@link QueryValidationError} that carries the base SQL and
   * the row index so a corrupt row in an `.all()` result is easy to locate.
   */
  function parseResult(row: unknown, rowIndex?: number): z.infer<ResultSchema> {
    const coerced = coerceRow(row as Record<string, unknown>)
    try {
      return resultSchema.parse(coerced) as z.infer<ResultSchema>
    } catch (cause) {
      throw new QueryValidationError({ sql: baseSql, rowIndex, cause })
    }
  }

  /**
   * Validates raw params against the params schema, serializes them to
   * SQLite-bindable primitives, then applies the driver's param-key prefix so
   * the result is ready to pass straight to a statement's `.get()` / `.all()`.
   */
  function bind(
    rawParams: z.infer<ParamsSchema>,
  ): Record<string, ReturnType<typeof serializeRow>[string]> {
    const parsed = paramSchema.parse(rawParams) as Record<string, unknown>
    return prefixParamKeys(serializeRow(parsed), paramPrefix)
  }

  type CallOpts = {
    params: z.infer<ParamsSchema>
    where?: readonly WhereKey[]
    orderBy?: OrderKey
  }

  return {
    /** Fetches a single row, or `null` if no row matches. */
    one: (opts: CallOpts): z.infer<ResultSchema> | null => {
      const statement = getStatement(opts.where ?? [], opts.orderBy)
      const row = statement.get(bind(opts.params))
      return row ? parseResult(row) : null
    },
    /** Fetches all matching rows. Returns an empty array if none match. */
    all: (opts: CallOpts): z.infer<ResultSchema>[] => {
      const statement = getStatement(opts.where ?? [], opts.orderBy)
      const rows = statement.all(bind(opts.params))
      return rows.map((row, rowIndex) => parseResult(row, rowIndex))
    },
  }
}

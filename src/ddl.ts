import { z } from 'zod'
import {
  InvalidIdentifierError,
  NestedTypeError,
  UnsupportedDefaultError,
  UnsupportedZodTypeError,
} from './errors.js'
import { VALID_IDENTIFIER } from './identifiers.js'
import { isJsonColumn } from './json.js'

/**
 * Options for {@link zodToSqliteDDL}.
 */
export interface ZodToSqliteDDLOpts {
  /** Table name; validated against `[a-zA-Z_][a-zA-Z0-9_]*`. */
  table: string
  /** Zod object schema describing the table columns. */
  schema: z.ZodObject<z.ZodRawShape>
  /**
   * Column name(s) that form the primary key. A single name emits an inline
   * `PRIMARY KEY` constraint; two or more emit a table-level `PRIMARY KEY`
   * clause for composite keys.
   */
  primaryKey?: string[]
}

/** Internal column-generation options threaded from {@link zodToSqliteDDL}. */
interface ColumnOptions {
  isPrimaryKey: boolean
}

/** Shorthand for Zod 4's base type — the common ground of all schema shapes. */
type AnyZodType = z.core.$ZodType

/**
 * Generates a `CREATE TABLE IF NOT EXISTS` DDL statement from a Zod object
 * schema. The schema is the single source of truth: field types, nullability,
 * enum constraints, and primary key are all derived from it.
 *
 * Supported Zod → SQLite mappings:
 * - `z.string()` → `TEXT`
 * - `z.iso.datetime()` / `z.iso.date()` / `z.iso.time()` → `TEXT` (validated ISO 8601)
 * - `z.number()` → `REAL`; `z.number().int()` → `INTEGER`
 * - `z.boolean()` → `INTEGER` (0/1)
 * - `z.date()` → `TEXT` (ISO 8601)
 * - `z.enum([...])` → `TEXT CHECK(col IN (...))`
 * - `z.literal(...)` → `TEXT`/`INTEGER` + `CHECK`
 * - {@link zJsonSchema} / {@link zJsonArray} → `TEXT`
 * - `z.object()` / `z.array()` → throws {@link NestedTypeError}; use {@link zJsonSchema} instead
 *
 * @param opts.table - Table name; validated against `[a-zA-Z_][a-zA-Z0-9_]*`
 * @param opts.schema - Zod object schema describing the table columns
 * @param opts.primaryKey - Column(s) to designate as the primary key
 *
 * @returns A `CREATE TABLE IF NOT EXISTS` statement ready to pass to `db.run()`
 *
 * @throws {@link InvalidIdentifierError} when `table` fails identifier validation
 * @throws {@link NestedTypeError} when a column is a bare `ZodObject`/`ZodArray`
 * @throws {@link UnsupportedZodTypeError} when a column has no SQLite mapping
 */
export function zodToSqliteDDL(opts: ZodToSqliteDDLOpts): string {
  const { table, schema, primaryKey = [] } = opts

  if (!VALID_IDENTIFIER.test(table)) {
    throw new InvalidIdentifierError('table', table)
  }

  const isCompositePrimaryKey = primaryKey.length > 1
  const columns: string[] = []

  for (const [key, fieldType] of Object.entries(schema.shape)) {
    const isSinglePrimaryKey = !isCompositePrimaryKey && primaryKey[0] === key
    columns.push(
      zodFieldToColumn(key, fieldType, { isPrimaryKey: isSinglePrimaryKey }),
    )
  }

  if (isCompositePrimaryKey) {
    columns.push(`PRIMARY KEY (${primaryKey.join(', ')})`)
  }

  return `CREATE TABLE IF NOT EXISTS ${table} (\n  ${columns.join(',\n  ')}\n)`
}

/**
 * Generates a single column definition string (e.g. `"name TEXT NOT NULL"`)
 * from a field name and its Zod type.
 */
function zodFieldToColumn(
  name: string,
  fieldType: AnyZodType,
  options: ColumnOptions,
): string {
  const isNullable = isNullableType(fieldType)
  const inner = unwrap(fieldType)

  const sqlType = resolveColumnType(name, inner)
  const notNull = isNullable || options.isPrimaryKey ? '' : ' NOT NULL'
  const primaryKey = options.isPrimaryKey ? ' PRIMARY KEY' : ''
  const defaultClause = resolveDefaultClause(name, fieldType)
  const check = resolveCheckConstraint(name, inner)

  return `${name} ${sqlType}${notNull}${primaryKey}${defaultClause}${check}`
}

/**
 * Returns true when the field permits SQL `NULL`. Peeks through any
 * `ZodDefault` wrapper because users can chain in either order
 * (`.default(x).nullable()` puts `ZodNullable` outermost; `.nullable().default(x)`
 * puts `ZodDefault` outermost). Without the peek, the latter form would emit
 * `NOT NULL DEFAULT x` instead of `DEFAULT x` — silent and undetectable until
 * a `NULL` write hit the column.
 */
function isNullableType(type: AnyZodType): boolean {
  let cursor: AnyZodType = type
  while (cursor instanceof z.ZodDefault) {
    cursor = cursor.def.innerType as AnyZodType
  }
  return cursor instanceof z.ZodOptional || cursor instanceof z.ZodNullable
}

/**
 * Extracts a `ZodDefault` wrapper anywhere in the field's wrapping chain and
 * renders the wrapped default value as a SQL `DEFAULT` clause. Supports finite
 * numbers, strings, and booleans. Throws {@link UnsupportedDefaultError} for
 * anything else (Date, object, array, NaN, Infinity, function-evaluated values
 * of those types) rather than silently omitting the clause — silent omission
 * causes the Zod parse layer and SQLite to diverge: Zod inserts the default,
 * SQLite stores `NULL`. Returns `''` when no default is present.
 */
function resolveDefaultClause(name: string, type: AnyZodType): string {
  let cursor: AnyZodType = type
  while (cursor instanceof z.ZodOptional || cursor instanceof z.ZodNullable) {
    cursor = cursor.def.innerType as AnyZodType
  }
  if (!(cursor instanceof z.ZodDefault)) return ''
  const definition = cursor.def as { defaultValue?: unknown }
  let value = definition.defaultValue
  if (typeof value === 'function') {
    value = (value as () => unknown)()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UnsupportedDefaultError(
        name,
        `non-finite number (${String(value)})`,
      )
    }
    return ` DEFAULT ${value}`
  }
  if (typeof value === 'string') return ` DEFAULT ${quoteSqlString(value)}`
  if (typeof value === 'boolean') return ` DEFAULT ${value ? 1 : 0}`
  throw new UnsupportedDefaultError(name, describeUnsupportedDefault(value))
}

/**
 * Produces the short human-readable label for a default value zqlite cannot
 * translate to a SQL `DEFAULT` clause (null / Date / array / other typeof).
 * Fed into the {@link UnsupportedDefaultError} message so the failure names
 * the offending kind rather than a generic "unsupported default".
 */
function describeUnsupportedDefault(value: unknown): string {
  if (value === null) return 'null'
  if (value instanceof Date) return 'Date'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Maps an unwrapped Zod type to a SQLite column type string. Detects integer
 * vs real number by inspecting the schema's `number_format` checks for an int
 * format (`safeint`, `int32`, `uint32`, etc.) — `safeParse(0.5)` would also
 * misfire on `z.number().positive()` or `z.number().min(1)`, both of which
 * reject `0.5` despite being REAL columns. Throws {@link NestedTypeError} on
 * `ZodObject`/`ZodArray` to force explicit {@link zJsonSchema} annotation
 * rather than silently emitting TEXT.
 */
function resolveColumnType(name: string, inner: AnyZodType): string {
  if (isJsonColumn(inner)) return 'TEXT'
  if (inner instanceof z.ZodString) return 'TEXT'
  if (
    inner instanceof z.ZodISODateTime ||
    inner instanceof z.ZodISODate ||
    inner instanceof z.ZodISOTime
  ) {
    return 'TEXT'
  }
  if (inner instanceof z.ZodNumber) {
    return isIntegerNumber(inner) ? 'INTEGER' : 'REAL'
  }
  if (inner instanceof z.ZodBoolean) return 'INTEGER'
  if (inner instanceof z.ZodDate) return 'TEXT'
  if (inner instanceof z.ZodEnum) return 'TEXT'
  if (inner instanceof z.ZodLiteral) {
    const firstValue = (inner.def.values as unknown[])[0]
    return typeof firstValue === 'number' ? 'INTEGER' : 'TEXT'
  }
  if (inner instanceof z.ZodObject || inner instanceof z.ZodArray) {
    throw new NestedTypeError(name)
  }
  throw new UnsupportedZodTypeError(name, inner.constructor.name)
}

/**
 * Returns an inline `CHECK` constraint string for enum and literal types, or
 * an empty string for types with no value constraint. Handles multi-value
 * literals (`z.literal(['a', 'b'])`) as `IN (...)` constraints.
 *
 * Single quotes inside string values are escaped per SQLite's doubled-quote
 * rule so `z.enum(["it's"])` produces a syntactically valid CHECK constraint.
 */
function resolveCheckConstraint(name: string, inner: AnyZodType): string {
  if (inner instanceof z.ZodEnum) {
    const values = Object.values(inner.def.entries as Record<string, string>)
      .map((sqlValue) => quoteSqlString(sqlValue))
      .join(', ')
    return ` CHECK(${name} IN (${values}))`
  }
  if (inner instanceof z.ZodLiteral) {
    const values = inner.def.values as unknown[]
    if (values.length === 1) {
      const formatted =
        typeof values[0] === 'string'
          ? quoteSqlString(values[0])
          : String(values[0])
      return ` CHECK(${name} = ${formatted})`
    }
    const formatted = values
      .map((sqlValue) =>
        typeof sqlValue === 'string'
          ? quoteSqlString(sqlValue)
          : String(sqlValue),
      )
      .join(', ')
    return ` CHECK(${name} IN (${formatted}))`
  }
  return ''
}

/**
 * SQLite-storable integer formats used by Zod 4's `number_format` checks.
 * `safeint` is what `.int()` emits; the size-bound variants come from helpers
 * like `z.int32()` / `z.uint32()`. Anything outside this set means the column
 * stores fractional values and maps to `REAL`.
 */
const INTEGER_NUMBER_FORMATS = new Set([
  'safeint',
  'int32',
  'uint32',
  'int',
  'uint',
])

/**
 * True iff the {@link z.ZodNumber} schema has an explicit integer constraint
 * (`.int()` or any of the int-format helpers). Examines the schema's checks
 * directly rather than probing with a fractional value, because constraints
 * like `.positive()` or `.min(1)` reject `0.5` despite being valid `REAL`
 * columns — see comment on {@link resolveColumnType}.
 */
function isIntegerNumber(inner: z.ZodNumber): boolean {
  const checks = (inner.def.checks ?? []) as Array<{
    def?: { check?: string; format?: string }
  }>
  return checks.some(
    (check) =>
      check.def?.check === 'number_format' &&
      typeof check.def.format === 'string' &&
      INTEGER_NUMBER_FORMATS.has(check.def.format),
  )
}

/**
 * Wraps a string in single quotes and escapes any embedded single quotes by
 * doubling them — SQLite's standard string-literal escape. Without this, a
 * value like `it's` would close the literal early and emit invalid SQL.
 */
function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Recursively strips `ZodOptional`, `ZodNullable`, and `ZodDefault` wrappers
 * to reach the concrete inner type used for SQLite type mapping.
 */
function unwrap(type: AnyZodType): AnyZodType {
  if (
    type instanceof z.ZodOptional ||
    type instanceof z.ZodNullable ||
    type instanceof z.ZodDefault
  ) {
    return unwrap(type.def.innerType as AnyZodType)
  }
  return type
}

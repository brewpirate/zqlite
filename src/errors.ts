/**
 * Base class for all errors thrown by zqlite. Callers can catch every
 * package-origin failure with a single `instanceof ZqliteError`, then narrow
 * with the concrete subtypes when they need to react differently.
 */
export class ZqliteError extends Error {
  override name = 'ZqliteError'
}

/**
 * Identifier (table or column name) failed the `[a-zA-Z_][a-zA-Z0-9_]*` test
 * applied before any DDL or DML interpolation. Carries the offending value
 * so callers can surface it in their own error messages.
 */
export class InvalidIdentifierError extends ZqliteError {
  override name = 'InvalidIdentifierError'

  constructor(
    public readonly kind: 'table' | 'column',
    public readonly value: string,
  ) {
    super(`Invalid ${kind} name: "${value}"`)
  }
}

/**
 * A column definition string passed to {@link migrateAddColumn} contained a
 * `;` and was rejected before being interpolated into DDL. The check is a
 * backstop against trivial injection — definitions must still be developer
 * literals, never user input.
 */
export class InvalidColumnDefinitionError extends ZqliteError {
  override name = 'InvalidColumnDefinitionError'

  constructor(public readonly definition: string) {
    super(`Invalid column definition: "${definition}"`)
  }
}

/**
 * A schema field's Zod type has no SQLite mapping. Carries the column name
 * and the offending Zod constructor name so users can locate the field.
 */
export class UnsupportedZodTypeError extends ZqliteError {
  override name = 'UnsupportedZodTypeError'

  constructor(
    public readonly column: string,
    public readonly typeName: string,
  ) {
    super(`Unsupported Zod type for column "${column}": ${typeName}`)
  }
}

/**
 * A `ZodDefault` field has a default value that cannot be rendered as a SQL
 * literal — Date, object, array, NaN, Infinity, or a function-evaluated value
 * of one of those types. Thrown rather than silently omitting the DEFAULT
 * clause, since omission causes the Zod parse layer and the SQL layer to
 * silently diverge: Zod inserts the default; SQLite stores `NULL`.
 */
export class UnsupportedDefaultError extends ZqliteError {
  override name = 'UnsupportedDefaultError'

  constructor(
    public readonly column: string,
    public readonly reason: string,
  ) {
    super(
      `Unsupported default for column "${column}": ${reason}. Only finite numbers, strings, and booleans translate to SQL DEFAULT literals.`,
    )
  }
}

/**
 * A schema field used a bare `z.object()` or `z.array()` where {@link
 * zJsonSchema} or {@link zJsonArray} is required. Thrown rather than silently
 * emitting `TEXT` so JSON columns are always opt-in.
 */
export class NestedTypeError extends ZqliteError {
  override name = 'NestedTypeError'

  constructor(public readonly column: string) {
    super(
      `Column "${column}" is a nested type. Use zJsonSchema() or zJsonArray() to declare it as a JSON TEXT column.`,
    )
  }
}

/**
 * Two migrations supplied to {@link migrate} share the same version number.
 * Surfaced eagerly — a duplicate would otherwise silently apply only one of
 * the two SQL bodies.
 */
export class DuplicateMigrationVersionError extends ZqliteError {
  override name = 'DuplicateMigrationVersionError'

  constructor(public readonly version: number) {
    super(`Duplicate migration version: ${version}`)
  }
}

/**
 * `migrateAddColumn` found the column already exists but the existing column's
 * SQLite type differs from the leading type in the new `definition`. Catches
 * the most common drift case where a developer changes a column type in code
 * without realising production already has a different declared type. Only
 * the leading type token is compared — additional constraints (NOT NULL,
 * DEFAULT, COLLATE) are not checked.
 *
 * **Type comparison is a raw uppercased token match — SQLite's type-affinity
 * normalisation is not applied.** `VARCHAR(255)` and `TEXT` both have TEXT
 * affinity at runtime but compare unequal here. zqlite's own `zodToSqliteDDL`
 * only emits `INTEGER` / `REAL` / `TEXT` / `BLOB`, so internally-consistent
 * users won't trip this — but external callers migrating from a hand-written
 * schema with affinity-flexible types should be aware.
 */
export class ColumnTypeMismatchError extends ZqliteError {
  override name = 'ColumnTypeMismatchError'

  readonly table: string
  readonly column: string
  readonly expectedType: string
  readonly actualType: string

  constructor(opts: {
    table: string
    column: string
    expectedType: string
    actualType: string
  }) {
    super(
      `Column "${opts.column}" on "${opts.table}" already exists with type ${opts.actualType}; definition declares ${opts.expectedType}`,
    )
    this.table = opts.table
    this.column = opts.column
    this.expectedType = opts.expectedType
    this.actualType = opts.actualType
  }
}

/**
 * `migrateAddColumn` was asked to alter a table that does not exist. Closing
 * the prior silent-no-op behaviour means typo'd table names surface
 * immediately instead of failing at query time.
 */
export class MissingTableError extends ZqliteError {
  override name = 'MissingTableError'

  constructor(
    public readonly table: string,
    public readonly operation: string,
  ) {
    super(`Cannot ${operation}: table "${table}" does not exist`)
  }
}

/**
 * Result-row Zod validation failed inside a {@link defineQuery} handle. For
 * `.all()` the row index is included so corrupt-row debugging is fast; the
 * underlying Zod error is preserved as `cause`.
 */
export class QueryValidationError extends ZqliteError {
  override name = 'QueryValidationError'
  readonly sql: string
  readonly rowIndex?: number

  constructor(opts: { sql: string; rowIndex?: number; cause: unknown }) {
    const where = opts.rowIndex !== undefined ? ` (row ${opts.rowIndex})` : ''
    super(`Query result validation failed${where} for: ${opts.sql}`, {
      cause: opts.cause,
    })
    this.sql = opts.sql
    this.rowIndex = opts.rowIndex
  }
}

/**
 * A `define*` statement's SQL and its params schema disagree in a way that
 * would produce a silent or driver-dependent bug at runtime. Surfaced eagerly
 * at definition time (module init) so the failure is uniform across drivers
 * instead of silent on `bun:sqlite`, a NULL-bind on `node:sqlite`, or a throw
 * on `better-sqlite3`.
 *
 * Two fatal conditions are carried:
 * - `missingParams` — a `$name` placeholder in the SQL has no matching key in
 *   the params schema. On `bun:sqlite` this silently binds NULL; the check
 *   turns it into an eager, cross-driver error.
 * - `foreignPlaceholders` — a `:name` / `@name` / `?` placeholder syntax the
 *   library's `$`-keyed binding path does not fill, so it would silently bind
 *   NULL. zqlite documents `$name` placeholders only.
 *
 * A param declared but never referenced by the SQL is NOT fatal — it is a
 * documented pattern (a `createInsertSchema` superset with a partial-column
 * INSERT), so it is warned about (only when the param is required), never
 * thrown.
 */
export class PlaceholderMismatchError extends ZqliteError {
  override name = 'PlaceholderMismatchError'

  readonly sql: string
  readonly missingParams: string[]
  readonly foreignPlaceholders: string[]

  constructor(opts: {
    sql: string
    missingParams: string[]
    foreignPlaceholders: string[]
  }) {
    const problems: string[] = []
    if (opts.missingParams.length > 0) {
      const placeholders = opts.missingParams
        .map((name) => `$${name}`)
        .join(', ')
      problems.push(`placeholders with no matching param: ${placeholders}`)
    }
    if (opts.foreignPlaceholders.length > 0) {
      problems.push(
        `unsupported placeholder syntax (use $name): ${opts.foreignPlaceholders.join(', ')}`,
      )
    }
    super(
      `SQL does not match params schema — ${problems.join('; ')}. SQL: ${opts.sql}`,
    )
    this.sql = opts.sql
    this.missingParams = opts.missingParams
    this.foreignPlaceholders = opts.foreignPlaceholders
  }
}

/**
 * `execWrite` caught the user callback's error, then `ROLLBACK` itself failed.
 * The original error is stored on `originalError` (and as `cause`) so callers
 * never lose the trigger; `rollbackError` carries the rollback failure for
 * diagnostics. Indicates the database may be in an indeterminate state.
 */
export class TransactionRollbackError extends ZqliteError {
  override name = 'TransactionRollbackError'

  constructor(
    public readonly originalError: unknown,
    public readonly rollbackError: unknown,
  ) {
    super('Transaction failed and ROLLBACK also failed', {
      cause: originalError,
    })
  }
}

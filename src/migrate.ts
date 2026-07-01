import {
  ColumnTypeMismatchError,
  DuplicateMigrationVersionError,
  InvalidColumnDefinitionError,
  InvalidIdentifierError,
  MissingTableError,
} from './errors.js'
import { VALID_IDENTIFIER } from './identifiers.js'
import type { SqliteAdapter } from './types.js'

/**
 * Step inside a mixed-form {@link Migration.up} array. Each entry is either
 * a single DDL/DML SQL string or a callback that receives the adapter. Lets a
 * migration interleave declarative DDL with imperative helpers (e.g.
 * {@link migrateAddColumn}) inside one ordered list, without forcing the
 * whole `up` body into callback form just to use one helper.
 */
export type MigrationStep = string | ((db: SqliteAdapter) => void)

/**
 * A single versioned migration step.
 *
 * `up` accepts four forms — pick whichever fits the migration:
 *
 * - `string` — a single SQL statement. The original form; stays the obvious
 *   choice for one-off DDL changes.
 * - `string[]` — a list of single SQL statements applied in order inside the
 *   migration's transaction. Use this for baselines that span many CREATE
 *   TABLE / CREATE INDEX statements, since `db.prepare()` is single-statement
 *   only and a multi-statement string would error at parse time.
 * - `(db: SqliteAdapter) => void` — full callback access. Use for migrations
 *   that need conditional logic, intermediate `PRAGMA table_info` checks,
 *   or programmatic SQL generation. Throws inside the callback roll the
 *   surrounding transaction back; `schema_version` is not bumped.
 * - `MigrationStep[]` — mixed array of strings + callbacks. Use when a
 *   migration declares static DDL (CREATE TABLE / CREATE INDEX strings) and
 *   also invokes zqlite helpers like {@link migrateAddColumn}. Lets the
 *   migration stay declarative for the DDL half without forcing the whole
 *   body into a callback that hand-rolls `db.prepare(ddl).run()` per statement.
 *
 *   Do not call `db.transaction()` inside any callback — the body is already
 *   running inside an open transaction. bun:sqlite would emulate the nested
 *   call with a savepoint, which works but obscures the rollback semantics.
 */
export interface Migration {
  version: number
  up: string | string[] | ((db: SqliteAdapter) => void) | MigrationStep[]
}

/**
 * Applies pending migrations in version order, each wrapped in a transaction.
 * Creates a `schema_version` table on first run to track applied versions.
 * Safe to call on every startup — already-applied versions are skipped.
 *
 * Prefer this for greenfield tables. Use {@link migrateAddColumn} for additive
 * changes to existing live tables where you cannot afford downtime.
 *
 * @param db - The SQLite database connection
 * @param migrations - Ordered list of migration steps; gaps in version numbers
 * are allowed but versions must be monotonically increasing
 */
export function migrate(db: SqliteAdapter, migrations: Migration[]): void {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)',
  ).run()
  const versionResult = db
    .prepare('SELECT MAX(version) as maxVersion FROM schema_version')
    .get() as { maxVersion: number | null } | null
  const current = versionResult?.maxVersion ?? 0

  const sorted = [...migrations].sort(
    (first, second) => first.version - second.version,
  )
  let previous: Migration | undefined
  for (const migration of sorted) {
    if (previous && migration.version === previous.version) {
      throw new DuplicateMigrationVersionError(migration.version)
    }
    previous = migration
  }

  for (const migration of sorted) {
    if (migration.version <= current) continue
    db.transaction(() => {
      applyMigrationBody(db, migration.up)
      // Positional `?` binds identically across bun:sqlite, better-sqlite3,
      // and node:sqlite — unlike a named `$version`, which would need the
      // driver's paramPrefix and silently break under better-sqlite3.
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
        migration.version,
      )
    })()
  }
}

/**
 * Dispatches a {@link Migration.up} body to the matching execution path.
 * Kept as a separate function so the inner switch is testable in isolation
 * and the surrounding transaction wrapper stays simple.
 */
function applyMigrationBody(
  db: SqliteAdapter,
  up: string | string[] | ((db: SqliteAdapter) => void) | MigrationStep[],
): void {
  if (typeof up === 'function') {
    up(db)
    return
  }
  if (Array.isArray(up)) {
    for (const step of up) {
      if (typeof step === 'function') {
        step(db)
      } else {
        db.prepare(step).run()
      }
    }
    return
  }
  db.prepare(up).run()
}

/**
 * Idempotent column add. Checks `PRAGMA table_info` before altering — harmless
 * to call repeatedly if the column already exists.
 *
 * Use for additive migrations on existing live databases where {@link migrate}
 * version tracking is not in place, or as a supplement to it.
 *
 * @param opts.db - The SQLite database connection
 * @param opts.table - Table to alter; validated against `[a-zA-Z_][a-zA-Z0-9_]*`
 * @param opts.column - Column name to add; validated against the same pattern
 * @param opts.definition - Full SQL column definition, e.g. `"TEXT NOT NULL DEFAULT 'x'"`.
 *   **Must be a developer-controlled literal.** Never pass user-supplied input here;
 *   the value is interpolated directly into DDL SQL without further escaping.
 *   Strings containing `;` are rejected to block the most obvious injection vector,
 *   but that guard is a backstop — not a substitute for keeping this argument trusted.
 *
 * @throws {@link InvalidIdentifierError} when `table` or `column` fails identifier validation
 * @throws {@link InvalidColumnDefinitionError} when `definition` contains `;`
 * @throws {@link MissingTableError} when the target table does not exist —
 *   surfaces typo'd table names immediately rather than silently no-op'ing
 *   and failing later at query time
 * @throws {@link ColumnTypeMismatchError} when the column already exists but
 *   its declared SQLite type differs from the leading type token of the new
 *   `definition`. Only the leading type is compared as a raw uppercased
 *   token; constraint differences (NOT NULL, DEFAULT, COLLATE) and SQLite
 *   type-affinity equivalence (e.g. `VARCHAR(255)` vs `TEXT`) are not detected.
 */
export function migrateAddColumn(opts: {
  db: SqliteAdapter
  table: string
  column: string
  definition: string
}): void {
  const { db, table, column, definition } = opts

  if (!VALID_IDENTIFIER.test(table))
    throw new InvalidIdentifierError('table', table)
  if (!VALID_IDENTIFIER.test(column))
    throw new InvalidIdentifierError('column', column)
  if (definition.includes(';'))
    throw new InvalidColumnDefinitionError(definition)

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
    type: string
  }[]
  if (columns.length === 0) {
    throw new MissingTableError(table, 'add column')
  }

  const columnLower = column.toLowerCase()
  const existing = columns.find(
    (columnInfo) => columnInfo.name.toLowerCase() === columnLower,
  )
  if (existing) {
    const expectedType = leadingType(definition)
    const actualType = leadingType(existing.type)
    if (
      expectedType !== '' &&
      actualType !== '' &&
      expectedType !== actualType
    ) {
      throw new ColumnTypeMismatchError({
        table,
        column,
        expectedType,
        actualType,
      })
    }
    return
  }

  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run()
}

/**
 * Extracts the leading type token from a SQL column declaration, normalised
 * to upper case. Used by {@link migrateAddColumn} to detect type drift when
 * the column already exists. Constraint-bearing tokens (`NOT`, `DEFAULT`,
 * etc.) never appear first in a valid declaration, so taking the first
 * whitespace-separated token is sufficient.
 */
function leadingType(declaration: string): string {
  return declaration.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
}

/**
 * Idempotent column drop with optional backfill. Companion to
 * {@link migrateAddColumn} (cross-referenced for navigation; the two helpers
 * have different error surfaces and aren't strict inverses). When a
 * `backfill` SQL is provided it runs before the drop, typically to copy the
 * column being dropped into a replacement column.
 *
 * Order matters and is load-bearing for idempotency:
 * 1. Verify the table exists (throws {@link MissingTableError} otherwise).
 * 2. If the column is already gone, return — both backfill and drop are
 *    skipped. The backfill is meaningless without its source column, so
 *    re-running this helper after a successful drop is a clean no-op.
 * 3. Run `backfill` (if provided), then `ALTER TABLE … DROP COLUMN`.
 *
 * Column lookup is case-insensitive — SQLite identifiers are case-insensitive,
 * so `column: 'Label'` matches a declared `label TEXT` column.
 *
 * Atomicity: this helper does **not** wrap the backfill+drop in a transaction.
 * Callers that need atomicity should wrap the call in {@link execWrite}.
 *
 * Retry safety: the column-presence check on step 2 makes a *second* call to
 * this helper a no-op once the column is gone. Whether a retry after a
 * partial failure is safe depends on the backfill: only **idempotent
 * backfills** (e.g. guarded with `WHERE new_col IS NULL`) are safe to
 * re-execute. A backfill without a guard re-applies on retry against rows
 * whose source column still exists, double-applying the update.
 *
 * No `;` guard is applied to `backfill` — it is the full SQL statement, not a
 * fragment interpolated into DDL. Pass a single statement; multi-statement
 * input behaviour is driver-dependent (`bun:sqlite` typically rejects or
 * silently drops the trailing statements).
 *
 * Requires SQLite 3.35.0+ (March 2021) for `ALTER TABLE DROP COLUMN`. Bun's
 * bundled SQLite satisfies this; `better-sqlite3` users should verify their
 * system SQLite version.
 *
 * @param opts.db - The SQLite database connection
 * @param opts.table - Table to alter; validated against `[a-zA-Z_][a-zA-Z0-9_]*`
 * @param opts.column - Column to drop; validated against the same pattern
 * @param opts.backfill - Optional SQL run before the drop, typically an
 *   `UPDATE … WHERE new_col IS NULL` that copies this column into a
 *   replacement. **Must be a single statement.** **Must be a
 *   developer-controlled literal** — interpolated directly with no escaping.
 *   Idempotent backfills (with `WHERE` guards against double-application)
 *   make the whole helper safe to retry; non-guarded backfills are not
 *   retry-safe.
 *
 * @throws {@link InvalidIdentifierError} when `table` or `column` fails identifier validation
 * @throws {@link MissingTableError} when the target table does not exist
 * @throws SQLite errors from `backfill` execution (syntax errors, constraint
 *   violations, references to non-existent columns) — propagated unwrapped.
 *   The drop does not run if the backfill throws.
 * @throws SQLite errors from the drop itself — most commonly when the column
 *   is referenced by an index, unique constraint, or CHECK constraint.
 *   Drop the dependent objects first.
 */
export function migrateDropColumn(opts: {
  db: SqliteAdapter
  table: string
  column: string
  backfill?: string
}): void {
  const { db, table, column, backfill } = opts

  if (!VALID_IDENTIFIER.test(table))
    throw new InvalidIdentifierError('table', table)
  if (!VALID_IDENTIFIER.test(column))
    throw new InvalidIdentifierError('column', column)

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  if (columns.length === 0) {
    throw new MissingTableError(table, 'drop column')
  }
  const columnLower = column.toLowerCase()
  if (
    !columns.some((columnInfo) => columnInfo.name.toLowerCase() === columnLower)
  )
    return

  if (backfill !== undefined) {
    db.prepare(backfill).run()
  }
  db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run()
}

/**
 * Idempotent column rename. Renames `from` to `to` only when the table still
 * carries the legacy `from` column and does not yet have `to`. Companion to
 * {@link migrateAddColumn} / {@link migrateDropColumn} (same guarded-PRAGMA
 * shape; not a strict inverse of either).
 *
 * The presence guard is the whole point: a column rename can NOT be expressed
 * as a bare `ALTER TABLE … RENAME COLUMN` migration string, because this
 * repo's baseline migration generates table DDL *from* the current row schema.
 * Once the row schema names the column `to`, a fresh database is created with
 * `to` directly and never has a `from` column — a bare rename would fail there
 * with "no such column: <from>". Gating on "has `from` and not `to`" makes the
 * migration a clean no-op on both a fresh DB (already `to`) and a re-run.
 *
 * Column lookup is case-insensitive — SQLite identifiers are case-insensitive,
 * so `from: 'TS'` matches a declared `ts` column.
 *
 * SQLite's `ALTER TABLE … RENAME COLUMN` (3.25.0+) rewrites references to the
 * column inside dependent index / trigger / view definitions in place, so an
 * index over `from` keeps working under its original name — no drop/recreate
 * is required. Bun's bundled SQLite satisfies the version requirement.
 *
 * Atomicity: this helper does **not** wrap its work in a transaction. The
 * {@link migrate} runner already wraps each migration body in one; callers
 * using this helper outside that runner should wrap it in {@link execWrite}.
 *
 * @param opts.db - The SQLite database connection
 * @param opts.table - Table to alter; validated against `[a-zA-Z_][a-zA-Z0-9_]*`
 * @param opts.from - Existing (legacy) column name; validated against the same pattern
 * @param opts.to - New column name; validated against the same pattern
 *
 * @throws {@link InvalidIdentifierError} when `table`, `from`, or `to` fails identifier validation
 * @throws {@link MissingTableError} when the target table does not exist —
 *   surfaces typo'd table names immediately rather than silently no-op'ing
 */
export function migrateRenameColumn(opts: {
  db: SqliteAdapter
  table: string
  from: string
  to: string
}): void {
  const { db, table, from, to } = opts

  if (!VALID_IDENTIFIER.test(table))
    throw new InvalidIdentifierError('table', table)
  if (!VALID_IDENTIFIER.test(from))
    throw new InvalidIdentifierError('column', from)
  if (!VALID_IDENTIFIER.test(to)) throw new InvalidIdentifierError('column', to)

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  if (columns.length === 0) {
    throw new MissingTableError(table, 'rename column')
  }

  const fromLower = from.toLowerCase()
  const toLower = to.toLowerCase()
  const hasFromColumn = columns.some(
    (columnInfo) => columnInfo.name.toLowerCase() === fromLower,
  )
  const hasToColumn = columns.some(
    (columnInfo) => columnInfo.name.toLowerCase() === toLower,
  )
  // Only rename when the legacy column is present and the new one is absent —
  // a fresh DB (created with `to` directly) and a completed re-run both skip.
  if (hasFromColumn && !hasToColumn) {
    db.prepare(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`).run()
  }
}

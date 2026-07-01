# zqlite API reference

Complete reference for every export. For a guided introduction see
[getting-started.md](./getting-started.md); for task-oriented patterns see
[recipes.md](./recipes.md).

All examples referenced here live in [`../examples/`](../examples) and are
type-checked by `bun run check`.

---

## Queries

### `defineQuery(options)`

Compiles a SELECT (or any row-returning statement, including `RETURNING`)
once and returns a handle. Both boundaries are Zod-validated: params before
binding, result rows after fetching.

| Option | Type | Description |
|---|---|---|
| `db` | `SqliteAdapter` | Database connection |
| `params` | `z.ZodObject` | Schema for named parameters — must be an object |
| `result` | `z.ZodType` | Schema for result rows |
| `sql` | `string` | SQL with `$name` placeholders (see the placeholder rule below) |
| `skipPlaceholderCheck` | `boolean` | Opt out of the define-time placeholder check (default `false`) |

Returns `{ one, all, run }`:

- `.one(params)` → `Result | null`
- `.all(params)` → `Result[]`
- `.run(params)` → `void` (use `defineWrite` instead for writes that don't
  return rows — `.run` here exists for statements you don't read back)

**Placeholder rule.** Only `$name` placeholders are supported, and they are
cross-checked against the `params` schema at define time. `defineQuery` throws
`PlaceholderMismatchError` when the SQL uses a non-`$name` syntax (`:name`,
`@name`, or positional `?`), or when a `$name` placeholder has no matching key
in `params`. This turns a silent bug — a mismatched name binds `NULL` on
`bun:sqlite` but throws on `node:sqlite` / `better-sqlite3` — into a uniform,
eager error on every driver. Pass `skipPlaceholderCheck: true` to disable it for
one handle (e.g. SQL built in a way the static check can't follow).

Throws `QueryValidationError` when a result row fails validation; for `.all()`
the error carries the offending row's index.

See [`examples/01-quickstart.ts`](../examples/01-quickstart.ts).

### `defineWrite(options)`

Compiles an INSERT / UPDATE / DELETE / DDL statement. Has no `result` schema —
writes don't return rows. Both methods return the driver's `SqliteRunResult`.

| Option | Type | Description |
|---|---|---|
| `db` | `SqliteAdapter` | Database connection |
| `params` | `z.ZodObject` | Schema for named parameters — must be an object |
| `sql` | `string` | SQL with `$name` placeholders (same rule as `defineQuery`) |
| `skipPlaceholderCheck` | `boolean` | Opt out of the define-time placeholder check (default `false`) |

Placeholders follow the same rule as [`defineQuery`](#definequeryoptions): `$name`
only, cross-checked against `params` at define time, throwing
`PlaceholderMismatchError` on a non-`$name` syntax or an unmatched name.

Returns `{ run, runInTransaction }`:

- `.run(params)` → `SqliteRunResult` — execute outside any transaction
- `.runInTransaction(params)` → `SqliteRunResult` — wrap this single statement
  in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. Use instead of
  `execWrite(db, () => handle.run(...))` for a single write.

For two or more writes that must be atomic, use [`execWrite`](#execwritedb-writeoperations).

See [`examples/02-writes.ts`](../examples/02-writes.ts).

### `defineDynamicQuery(options)`

Composes a SELECT whose `WHERE` / `ORDER BY` shape varies per call. Replaces
both the N-handles-per-combination pattern and the index-defeating
`WHERE ($x IS NULL OR col = $x)` idiom.

| Option | Type | Description |
|---|---|---|
| `db` | `SqliteAdapter` | Database connection |
| `params` | `z.ZodObject` | Schema for named parameters |
| `result` | `z.ZodType` | Schema for result rows |
| `sql` | `string` | Base SELECT **without** trailing `WHERE` / `ORDER BY` |
| `where` | `Record<string, string>` | Named predicate fragments (no leading `WHERE`/`AND`) |
| `order` | `Record<string, string>` | Named ORDER BY clauses (the body, e.g. `'pages DESC'`) |

Returns `{ one, all }`. Each takes an options object:

```ts
handle.all({ params, where?: readonly Key[], orderBy?: Key })
```

- `where` lists which fragments to **activate** — activation is explicit, not
  derived from whether a param is null. Active fragments are AND-joined;
  inactive ones are omitted from the SQL entirely.
- `orderBy` selects at most one `order` entry.
- Each unique `(where, orderBy)` shape compiles one prepared statement, cached
  by a sorted fragment signature (so `['a','b']` and `['b','a']` share it).

Scope the handle to a router factory or module init so the cache is reused for
the process lifetime.

See [`examples/03-dynamic-queries.ts`](../examples/03-dynamic-queries.ts).

---

## DDL

### `zodToSqliteDDL(options)`

Generates a `CREATE TABLE IF NOT EXISTS` statement from a schema.

| Option | Type | Description |
|---|---|---|
| `table` | `string` | Validated against `[a-zA-Z_][a-zA-Z0-9_]*` |
| `schema` | `z.ZodObject` | Column schema |
| `primaryKey` | `string[]` | Primary key column(s); 2+ emits a composite key |

Throws `InvalidIdentifierError` (bad table name), `NestedTypeError` (a bare
`ZodObject`/`ZodArray` field — wrap it in `zJsonSchema`), or
`UnsupportedZodTypeError` (any other unmapped Zod type).

#### Zod → SQLite type mapping

| Zod type | SQLite type | Notes |
|---|---|---|
| `z.string()` | `TEXT` | |
| `z.number()` | `REAL` | |
| `z.number().int()` | `INTEGER` | |
| `z.boolean()` | `INTEGER` | 0/1, coerced to boolean on read |
| `z.date()` | `TEXT` | ISO 8601, coerced to Date on read |
| `z.enum(['a','b'])` | `TEXT` | adds `CHECK(col IN ('a','b'))` |
| `z.literal('x')` | `TEXT` | adds `CHECK(col = 'x')` |
| `z.literal(1)` | `INTEGER` | adds `CHECK(col = 1)` |
| `zJsonSchema(...)` | `TEXT` | JSON-serialized; parsed on read |
| `zJsonArray()` | `TEXT` | JSON-serialized array; parsed on read |
| `.optional()` | — | column allows NULL |
| `.default(v)` | adds `DEFAULT v` | see note below |

**`.default(v)` gotcha:** a defaulted column is emitted as
`... NOT NULL DEFAULT v`. The default only applies when the column is **omitted
from the INSERT column list** — if you list it and bind an omitted param, you
bind NULL and violate NOT NULL. See
[`examples/02-writes.ts`](../examples/02-writes.ts).

---

## Operation schemas

Derive insert/update variants from a base schema instead of hand-writing
`.omit()` / `.partial()`.

| Operation | Nullable field | Field with default | Required field |
|---|---|---|---|
| `createSelectSchema` | nullable | as-is | required |
| `createInsertSchema` | optional | optional | required |
| `createUpdateSchema` | optional | optional | optional |

### `createSelectSchema(schema, refine?)`

Returns the base schema with optional per-field refinements applied.

### `createInsertSchema(schema, refine?)`

Nullable → optional, defaulted → optional. Required stays required.

### `createUpdateSchema(schema, refine?)`

Every field optional. Extend with `.extend({ id: z.string() })` to re-add the
WHERE key as required.

`refine` is a per-field map of either a replacement schema or a
`(schema) => schema` transform, applied **after** the optionality transform.

See [`examples/06-full-table.ts`](../examples/06-full-table.ts).

---

## JSON columns

### `zJsonSchema(schema, defaultValue?)`

Wraps a Zod schema for a JSON TEXT column. Serializes on write; parses and
validates against the inner schema on read. `defaultValue` is returned when the
stored value is an empty string.

### `zJsonArray(defaultValue?)`

Schema for an untyped JSON array column (`defaultValue` defaults to `[]`).
Prefer `zJsonSchema(z.array(...))` when the element shape is known — it
validates elements on read.

See [`examples/05-json-columns.ts`](../examples/05-json-columns.ts).

---

## Migrations

### `migrate(db, migrations)`

Applies pending migrations in version order, each in its own transaction.
Creates a `schema_version` table on first run; already-applied versions are
skipped, so it's safe to call on every startup.

Each migration is `{ version: number, up }`, where `up` is one of:

```ts
{ version: 1, up: 'CREATE TABLE …' }                       // single statement
{ version: 2, up: ['CREATE TABLE a …', 'CREATE INDEX …'] } // ordered list
{ version: 3, up: (db) => { /* arbitrary code */ } }       // callback
```

The array form suits multi-statement baselines (`db.prepare` is
single-statement). The callback form allows `PRAGMA table_info` checks and
conditional logic; throwing inside it rolls back the transaction and leaves
`schema_version` untouched. Throws `DuplicateMigrationVersionError` if two
migrations share a version.

### `migrateAddColumn(options)`

Idempotent `ALTER TABLE ADD COLUMN` — no-op if the column already exists.

| Option | Type | Description |
|---|---|---|
| `db` | `SqliteAdapter` | Database connection |
| `table` | `string` | Validated against the identifier regex |
| `column` | `string` | Validated against the identifier regex |
| `definition` | `string` | e.g. `"TEXT NOT NULL DEFAULT 'x'"` — must be a developer literal |

Throws `MissingTableError` (typo'd table), `InvalidColumnDefinitionError`
(`definition` contains `;`), or `ColumnTypeMismatchError` (column exists with a
different leading SQL type than the new `definition`).

### `migrateDropColumn(options)`

Idempotent `ALTER TABLE DROP COLUMN` with optional backfill. No-op if the
column is already gone. Requires SQLite 3.35.0+.

| Option | Type | Description |
|---|---|---|
| `db` | `SqliteAdapter` | Database connection |
| `table` | `string` | Validated against the identifier regex |
| `column` | `string` | Validated against the identifier regex |
| `backfill` | `string?` | SQL run before the drop, typically a guarded `UPDATE` |

The backfill runs before the drop and is skipped once the column is gone, so
the call is safe to retry. Does not wrap backfill+drop in a transaction — wrap
the call in `execWrite` if you need atomicity.

See [`examples/04-migrations.ts`](../examples/04-migrations.ts).

---

## Transactions

### `execWrite(db, writeOperations)`

Wraps `writeOperations` in `BEGIN IMMEDIATE` / `COMMIT`, rolling back and
re-throwing on error. Returns whatever the callback returns. `BEGIN IMMEDIATE`
takes the write lock upfront so concurrent writers queue at the reserved lock
instead of racing into `SQLITE_BUSY`.

If the rollback *itself* fails, throws `TransactionRollbackError` carrying both
the original error and the rollback failure — the database may be in an
indeterminate state; log and surface it, never swallow it.

Use for two or more writes that must be atomic. For a single write, prefer
`defineWrite(...).runInTransaction(...)`.

---

## Driver interfaces

### `SqliteAdapter` / `SqliteStatement` / `SqliteRunResult`

The driver surface zqlite depends on. `bun:sqlite`'s `Database` satisfies it
directly. Implement these to support any other driver.

```ts
interface SqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

interface SqliteStatement {
  get(...parameters: unknown[]): unknown
  all(...parameters: unknown[]): unknown[]
  run(...parameters: unknown[]): SqliteRunResult
}

interface SqliteAdapter {
  prepare(sql: string): SqliteStatement
  transaction<CallbackResult>(callback: () => CallbackResult): () => CallbackResult
  paramPrefix?: string
}
```

Set `paramPrefix: ''` for drivers that expect bare keys in named-parameter bind
objects (`better-sqlite3`, `node:sqlite`); `bun:sqlite` uses the default `'$'`.
See [recipes.md → Multiple drivers](./recipes.md#multiple-drivers).

### `configureZqliteAdapter(db, opts?)`

Applies the PRAGMAs that zqlite's read/write machinery assumes — WAL journaling,
`synchronous = NORMAL`, a 5 s `busy_timeout`, and optionally foreign-key
enforcement (`foreignKeys: true`). Returns `void`. Call once on a
freshly-constructed adapter before passing it to `defineQuery`, `execWrite`, and
`migrate`. All `opts` fields are optional overrides of those defaults.

This does **not** set `paramPrefix` — that's a property you set directly on the
connection (`Object.assign(db, { paramPrefix: '' })`) for `better-sqlite3` /
`node:sqlite`. See [recipes.md → Multiple drivers](./recipes.md#multiple-drivers).

---

## Errors

Every error extends `ZqliteError`, so one `instanceof` check catches all
package-origin failures; narrow with the concrete subtype as needed.

```ts
import { ZqliteError, MissingTableError, QueryValidationError } from 'zqlite'

try {
  // …zqlite work…
} catch (error) {
  if (error instanceof MissingTableError) { /* … */ }
  else if (error instanceof QueryValidationError) {
    // error.sql, error.rowIndex, error.cause (the underlying ZodError)
  } else if (error instanceof ZqliteError) { /* generic zqlite failure */ }
  else throw error
}
```

| Error | Source | Notes |
|---|---|---|
| `InvalidIdentifierError` | DDL, migrations | Table/column name failed validation |
| `InvalidColumnDefinitionError` | `migrateAddColumn` | `definition` contained `;` |
| `UnsupportedZodTypeError` | `zodToSqliteDDL` | Field has no SQLite mapping |
| `NestedTypeError` | `zodToSqliteDDL` | Bare `ZodObject`/`ZodArray` — use `zJsonSchema` |
| `MissingTableError` | `migrateAddColumn`, `migrateDropColumn` | Target table does not exist |
| `ColumnTypeMismatchError` | `migrateAddColumn` | Column exists with a different declared type |
| `DuplicateMigrationVersionError` | `migrate` | Two migrations share a version |
| `QueryValidationError` | `defineQuery`, `defineDynamicQuery` | Result row failed validation; carries `sql`, `rowIndex`, `cause` |
| `PlaceholderMismatchError` | `defineQuery`, `defineWrite` | SQL placeholder doesn't match params at define time — non-`$name` syntax (`:name`/`@name`/`?`) or an unmatched `$name`. Bypass with `skipPlaceholderCheck` |
| `TransactionRollbackError` | `execWrite`, `.runInTransaction` | Callback **and** `ROLLBACK` failed; DB may be indeterminate |

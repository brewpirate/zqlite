# zqlite recipes

Task-oriented patterns. Each section links a runnable, type-checked example in
[`../examples/`](../examples). For the guided introduction start with
[getting-started.md](./getting-started.md); for exhaustive signatures see
[api-reference.md](./api-reference.md).

- [Writes & transactions](#writes--transactions)
- [Dynamic queries](#dynamic-queries)
- [JSON columns](#json-columns)
- [Operation schemas](#operation-schemas)
- [Migrations](#migrations)
- [Multiple drivers](#multiple-drivers)
- [Error handling](#error-handling)

---

## Writes & transactions

Use `defineWrite` for INSERT / UPDATE / DELETE. It returns the driver's
`{ changes, lastInsertRowid }`.

```ts
const markFinished = defineWrite({
  db,
  params: z.object({ book_id: z.string() }),
  sql: 'UPDATE books SET finished = 1 WHERE book_id = $book_id',
})

const { changes } = markFinished.run({ book_id: 'bk_1' }) // changes: 1
```

**One write, atomically** — `.runInTransaction()` wraps the single statement in
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`:

```ts
markFinished.runInTransaction({ book_id: 'bk_1' })
```

**Two or more writes, atomically** — `execWrite`. Either all commit or none do:

```ts
import { execWrite } from 'zqlite'

execWrite(db, () => {
  lendBook.run({ book_id: 'bk_1', borrower: 'ada' })
  logActivity.run({ detail: 'bk_1 lent to ada' })
})
```

`BEGIN IMMEDIATE` takes the write lock upfront, so concurrent writers queue at
the reserved lock instead of racing into `SQLITE_BUSY`. Reach for `execWrite`
any time multiple writes must be atomic or writers share the database.

> **`defineWrite` prepares immediately.** Every table a write references must
> already exist when you call `defineWrite` — define handles after `migrate`.

See [`examples/02-writes.ts`](../examples/02-writes.ts).

## Dynamic queries

When a list query filters on different column combinations per call, don't
write `WHERE ($x IS NULL OR col = $x)` (it defeats indexes) and don't hand-roll
one handle per combination (combinatorial). Use `defineDynamicQuery`: declare
every fragment up front, activate per call.

```ts
const listBooks = defineDynamicQuery({
  db,
  params: z.object({
    author: z.string().optional(),
    min_pages: z.number().int().optional(),
  }),
  result: BookSchema,
  sql: 'SELECT * FROM books',
  where: {
    finished: 'finished = 1',
    byAuthor: 'author = $author',
    longerThan: 'pages >= $min_pages',
  },
  order: { title: 'title ASC', longest: 'pages DESC' },
})

// activate the fragments you want; inactive ones are omitted from the SQL
listBooks.all({ params: { author: 'Herbert' }, where: ['byAuthor'], orderBy: 'title' })
listBooks.all({ params: { min_pages: 300 }, where: ['finished', 'longerThan'], orderBy: 'longest' })
```

Activation is explicit — a null param does **not** drop a predicate. Each
unique `(where, orderBy)` shape compiles one cached prepared statement; sort
order of the `where` array doesn't matter. Scope the handle to a router factory
or module init so the cache lives for the process.

**Pagination:** the primitive exposes the ORDER BY tail only. SQLite requires
`LIMIT` / `OFFSET` after `ORDER BY`, so if you need them, append to the `order`
entries (e.g. `'pages DESC LIMIT $limit OFFSET $offset'`).

See [`examples/03-dynamic-queries.ts`](../examples/03-dynamic-queries.ts).

## JSON columns

SQLite has no JSON type — JSON lives in TEXT. `zJsonSchema` wraps a Zod schema
so DDL emits TEXT, writes `JSON.stringify`, and reads `JSON.parse` **and
validate** against the inner schema.

```ts
const BookSchema = z.object({
  book_id: z.string(),
  metadata: zJsonSchema(z.object({ isbn: z.string(), edition: z.number().int() })),
  tags: zJsonArray<string>(), // untyped array; prefer zJsonSchema(z.array(...)) when shape is known
})
```

Callers pass real JS objects/arrays (not pre-stringified JSON) — `createInsertSchema`
swaps the read-side pipe for the underlying object type on insert/update. Bare
`z.object()` / `z.array()` fields throw at DDL time on purpose; opt into JSON
explicitly so it's visible in the schema.

See [`examples/05-json-columns.ts`](../examples/05-json-columns.ts).

## Operation schemas

Derive insert/update variants from the base schema instead of `.omit()` /
`.partial()` by hand:

```ts
const BookInsertSchema = createInsertSchema(BookSchema, {
  title: (schema) => schema.min(1).max(200), // per-field refinement
})
const BookUpdateSchema = createUpdateSchema(BookSchema).extend({ book_id: z.string() })
```

| Operation | Nullable field | Field with default | Required field |
|---|---|---|---|
| select | nullable | as-is | required |
| insert | optional | optional | required |
| update | optional | optional | optional |

> **DB-default gotcha.** A `.default(v)` field becomes optional in the insert
> schema *and* is emitted as `... NOT NULL DEFAULT v` in DDL. The default only
> applies when you **omit the column from the INSERT column list** — if you
> list it and bind an omitted param, you bind NULL and hit the NOT NULL
> constraint. So name only the columns you actually supply; let defaulted /
> nullable columns fall through. ([`examples/02-writes.ts`](../examples/02-writes.ts)
> shows the correct shape.)

## Migrations

**Versioned (greenfield):** `migrate` tracks applied versions, safe on every
startup. `up` is a single SQL string, an ordered `string[]`, or a `(db) =>
void` callback.

```ts
migrate(db, [
  { version: 1, up: zodToSqliteDDL({ table: 'books', schema: BookSchema, primaryKey: ['book_id'] }) },
  { version: 2, up: ['CREATE INDEX IF NOT EXISTS idx_books_title ON books(title)'] },
])
```

**Additive (live tables):** `migrateAddColumn` / `migrateDropColumn` are
idempotent — no-op if the column already exists / is already gone. Drop takes
an optional `backfill` that runs before the drop and is skipped once the column
is gone, so the call is retry-safe (requires SQLite 3.35.0+).

```ts
migrateAddColumn({ db, table: 'books', column: 'pages', definition: 'INTEGER' })
migrateDropColumn({
  db,
  table: 'books',
  column: 'legacy_rating',
  backfill: 'UPDATE books SET rating = legacy_rating WHERE rating IS NULL AND legacy_rating IS NOT NULL',
})
```

See [`examples/04-migrations.ts`](../examples/04-migrations.ts).

## Multiple drivers

zqlite isn't coupled to a driver — it works with anything satisfying
`SqliteAdapter`.

| Driver | Setup |
|---|---|
| [`bun:sqlite`](https://bun.sh/docs/api/sqlite) | `new Database(path)` directly — no wrapper. **Tested in CI (Bun).** |
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | Set `paramPrefix: ''` (it expects bare keys, not `$name`). **Tested in CI (Node); not supported under Bun.** |
| `node:sqlite` (Node 22+) | Needs a thin wrapper — no `.transaction()` method. **Tested in CI (Node 22 & 24).** |
| [`libsql`](https://github.com/tursodatabase/libsql) (local) | Set `paramPrefix: ''` (better-sqlite3-compatible). **Tested in CI (Bun & Node).** Local only — see note below. |

**better-sqlite3** — without `paramPrefix: ''` every named parameter silently
binds NULL (no error, wrong results):

```ts
import Database from 'better-sqlite3'
import type { SqliteAdapter } from 'zqlite'

const db: SqliteAdapter = Object.assign(new Database('app.db'), { paramPrefix: '' })
```

**node:sqlite** — `DatabaseSync` has no `.transaction()`; wrap it:

```ts
import { DatabaseSync } from 'node:sqlite'
import type { SqliteAdapter } from 'zqlite'

function adaptNodeSqlite(database: DatabaseSync): SqliteAdapter {
  return {
    paramPrefix: '',
    prepare: (sql) => database.prepare(sql),
    exec: (sql) => database.exec(sql),
    transaction: (callback) => () => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = callback()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}
```

**libsql** — Turso's SQLite fork. Its native package is a synchronous,
better-sqlite3-compatible `Database` that loads under both Bun and Node, so set
`paramPrefix: ''` and pass it directly:

```ts
import Database from 'libsql'
import type { SqliteAdapter } from 'zqlite'

const db: SqliteAdapter = Object.assign(new Database('app.db'), { paramPrefix: '' })
```

This covers **local** libsql databases. Turso **cloud** — remote access or
embedded replicas — is not yet supported: remote reads/writes are asynchronous,
and zqlite is currently sync-only (see the "Sync only" limitation in the
README).

## Error handling

Every error extends `ZqliteError` — one `instanceof` catches all package-origin
failures; narrow with the concrete subtype.

```ts
import { ZqliteError, QueryValidationError } from 'zqlite'

try {
  const rows = listBooks.all({ params: {} })
} catch (error) {
  if (error instanceof QueryValidationError) {
    // a stored row didn't match the schema — error.sql, error.rowIndex, error.cause
  } else if (error instanceof ZqliteError) {
    // any other zqlite failure
  } else throw error
}
```

`QueryValidationError` is the one you'll meet most: a row in the database didn't
match its result schema (a column drifted, a JSON blob is malformed). It carries
`sql`, the offending `rowIndex` (for `.all()`), and the underlying ZodError as
`cause`. The full error table is in
[api-reference.md → Errors](./api-reference.md#errors).

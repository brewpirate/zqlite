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
- [Async & Turso cloud](#async--turso-cloud)
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

> **`$name` placeholders only.** `defineQuery` and `defineWrite` accept only
> `$name` placeholders, and they cross-check the SQL against the `params` schema
> at define time — a non-`$name` syntax (`:name`, `@name`, positional `?`) or a
> `$name` with no matching params key throws `PlaceholderMismatchError` right
> away, on every driver (a mismatch would otherwise bind `NULL` silently on
> `bun:sqlite`). If you build SQL in a way the static check can't follow, pass
> `skipPlaceholderCheck: true` on that handle.

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
| [`node:sqlite`](https://nodejs.org/docs/latest/api/sqlite.html) (Node 22+) | Needs a thin wrapper — no `.transaction()` method. **Tested in CI (Node 22 & 24).** |
| [`libsql`](https://github.com/tursodatabase/libsql) (local, sync) | Needs a thin wrapper — `paramPrefix: ''` and strip its injected `_metadata`. **Tested in CI (Bun & Node).** This is the *local* driver; for remote **Turso cloud** use the async API (see [turso.md](./turso.md)). |

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
better-sqlite3-compatible `Database` that loads under both Bun and Node. It
needs a thin wrapper for two reasons: bare param keys (`paramPrefix: ''`), and
it injects a `_metadata` field into every `.get()` row. A non-strict result
schema (zqlite's default) ignores `_metadata`, but a `.strict()` schema would
reject it — so strip it at the boundary to make libsql behave like the other
drivers for every schema shape:

```ts
import Database from 'libsql'
import type { SqliteAdapter } from 'zqlite'

function adaptLibsql(database: Database): SqliteAdapter {
  const strip = (row: unknown) => {
    if (row && typeof row === 'object' && '_metadata' in row) {
      delete (row as Record<string, unknown>)._metadata
    }
    return row
  }
  return {
    paramPrefix: '',
    exec: (sql) => database.exec(sql),
    transaction: (callback) => database.transaction(callback),
    prepare: (sql) => {
      const statement = database.prepare(sql)
      return {
        get: (...params) => strip(statement.get(...params)),
        all: (...params) => statement.all(...params).map(strip),
        run: (...params) => statement.run(...params),
      }
    },
  }
}

const db = adaptLibsql(new Database('app.db'))
```

This covers **local** libsql databases (synchronous). For Turso **cloud** —
remote over HTTP — use the async API with `@libsql/client`, below.

## Async & Turso cloud

Remote Turso is asynchronous, so it uses a parallel async surface —
`defineAsyncQuery`, `defineAsyncWrite`, `execWriteAsync` — over
[`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts). Same
schema, same validation and coercion as the sync API; the calls just return
Promises, and `@libsql/client`'s `Client` satisfies `AsyncSqliteAdapter` with no
wrapper:

```ts
import { createClient } from '@libsql/client'
import { defineAsyncQuery } from 'zqlite'

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN, // a database auth token, not a platform token
})

const findBook = defineAsyncQuery({
  db,
  params: z.object({ book_id: z.string() }),
  result: BookSchema,
  sql: 'SELECT * FROM books WHERE book_id = $book_id',
})
const book = await findBook.one({ book_id: 'bk_1' }) // Book | null, fully coerced
```

Transactions (`execWriteAsync`), the database-vs-platform token distinction,
remote latency and `batch()`, and local `file:` development are all covered in
the **[Turso cloud guide](./turso.md)**, with a runnable
[`examples/07-turso-cloud.ts`](../examples/07-turso-cloud.ts).

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

# Getting started with zqlite

This walks you from an empty database to a working, type-safe table in about
five minutes. It assumes you're comfortable with TypeScript, SQL, and Zod — but
there are short asides for anyone newer to Zod or SQLite.

> **New to Zod?** A [Zod](https://zod.dev) schema describes a value's shape at
> runtime, and `z.infer<typeof Schema>` gives you the matching TypeScript type
> for free. You only need `z.object`, `z.string`, `z.number`, `z.boolean`,
> `z.date` to follow this guide.
>
> **New to SQLite?** [SQLite](https://www.sqlite.org) is a serverless SQL
> database that lives in a single file (or in memory). This guide uses
> [`bun:sqlite`](https://bun.sh/docs/api/sqlite), which ships with Bun;
> `new Database(':memory:')` gives you a throwaway database with no setup.

## Install

```bash
# Bun (recommended — bun:sqlite is built in)
bun add zqlite zod

# Node, with better-sqlite3
npm install zqlite zod better-sqlite3
```

zqlite needs a SQLite driver and Zod ^4 (a peer dependency). See
[recipes.md → Multiple drivers](./recipes.md#multiple-drivers) for Node setup.

## The one idea

A single Zod schema is the source of truth for three things at once:

1. your **TypeScript types**,
2. the **`CREATE TABLE`** statement,
3. **validation** on every query in and out.

Define the schema once; derive everything else. No `as YourType` casts, no
parallel interface that drifts from the table.

## Step 1 — Describe the table

```ts
import { z } from 'zod'

const BookSchema = z.object({
  book_id: z.string(),
  title: z.string(),
  pages: z.number().int(), // .int() → INTEGER (a plain z.number() → REAL)
  finished: z.boolean(), // stored as 0/1, handed back as a real boolean
})

type Book = z.infer<typeof BookSchema> // the TS type, derived
```

## Step 2 — Create the table from the schema

`zodToSqliteDDL` turns the schema into `CREATE TABLE IF NOT EXISTS`. Wrap it in
`migrate` so it runs once and is tracked in a `schema_version` table — safe to
call on every startup.

```ts
import { Database } from 'bun:sqlite'
import { migrate, zodToSqliteDDL } from 'zqlite'

const db = new Database(':memory:')

migrate(db, [
  {
    version: 1,
    up: zodToSqliteDDL({
      table: 'books',
      schema: BookSchema,
      primaryKey: ['book_id'],
    }),
  },
])
```

> Zod types map to SQLite columns predictably: `z.string()` → `TEXT`,
> `z.number().int()` → `INTEGER`, `z.boolean()` → `INTEGER` (0/1), `z.date()` →
> `TEXT` (ISO 8601). Full table in
> [api-reference.md](./api-reference.md#zod--sqlite-type-mapping).

## Step 3 — Write a row

`defineWrite` compiles an INSERT/UPDATE/DELETE once. `$book_id` and friends are
named placeholders matching the `params` schema keys. Params are validated and
serialized (here `finished: false` → `0`) before binding.

```ts
import { defineWrite } from 'zqlite'

const insertBook = defineWrite({
  db,
  params: BookSchema,
  sql: `INSERT INTO books (book_id, title, pages, finished)
        VALUES ($book_id, $title, $pages, $finished)`,
})

insertBook.run({ book_id: 'bk_1', title: 'Dune', pages: 412, finished: false })
```

## Step 4 — Read it back

`defineQuery` validates params going in, then **coerces and validates** each
row coming out — `0` becomes `false`, ISO strings become `Date`, JSON columns
become parsed objects — before you ever touch the value.

```ts
import { defineQuery } from 'zqlite'

const findBook = defineQuery({
  db,
  params: z.object({ book_id: z.string() }),
  result: BookSchema,
  sql: 'SELECT * FROM books WHERE book_id = $book_id',
})

const book: Book | null = findBook.one({ book_id: 'bk_1' })
// { book_id: 'bk_1', title: 'Dune', pages: 412, finished: false }
//                                              ^ a real boolean, not 0
```

That's the whole loop. The runnable version is
[`examples/01-quickstart.ts`](../examples/01-quickstart.ts) — run it with
`bun examples/01-quickstart.ts`.

## Where to go next

- **Writes, transactions, insert schemas** —
  [recipes.md → Writes](./recipes.md#writes--transactions) and
  [`examples/02-writes.ts`](../examples/02-writes.ts).
- **Filtering / sorting that varies per call** —
  [recipes.md → Dynamic queries](./recipes.md#dynamic-queries) and
  [`examples/03-dynamic-queries.ts`](../examples/03-dynamic-queries.ts).
- **Schema changes over time** —
  [recipes.md → Migrations](./recipes.md#migrations) and
  [`examples/04-migrations.ts`](../examples/04-migrations.ts).
- **Storing objects/arrays as JSON** —
  [recipes.md → JSON columns](./recipes.md#json-columns) and
  [`examples/05-json-columns.ts`](../examples/05-json-columns.ts).
- **Everything together on a realistic table** —
  [`examples/06-full-table.ts`](../examples/06-full-table.ts).
- **Every export, in detail** — [api-reference.md](./api-reference.md).

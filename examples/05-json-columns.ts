/**
 * 05 — JSON columns: store typed objects and arrays as TEXT.
 *
 * Run with:  bun examples/05-json-columns.ts
 *
 * SQLite has no JSON column type — JSON lives in a TEXT column. zqlite's
 * `zJsonSchema` / `zJsonArray` wrap a Zod schema so that:
 *
 *   - `zodToSqliteDDL` emits TEXT for the column
 *   - on write, the value is JSON.stringify'd automatically
 *   - on read, the string is JSON.parse'd AND validated against the schema
 *
 * Bare `z.object()` / `z.array()` fields are rejected at DDL time on purpose —
 * you must opt into JSON storage explicitly so it's visible in the schema.
 */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  createInsertSchema,
  defineQuery,
  defineWrite,
  migrate,
  zJsonArray,
  zJsonSchema,
  zodToSqliteDDL,
} from '../src/index'

const BookSchema = z.object({
  book_id: z.string(),
  title: z.string(),
  // A typed JSON object — the inner schema validates on read.
  metadata: zJsonSchema(
    z.object({ isbn: z.string(), edition: z.number().int() }),
  ),
  // A JSON array of strings. Prefer zJsonSchema(z.array(...)) when you want
  // element validation; zJsonArray skips it.
  tags: zJsonArray<string>(),
})

/** In-memory database so the JSON-column example runs without touching disk; the table is created by the migration below. */
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

// createInsertSchema swaps the read-side JSON pipe for the underlying object
// type, so callers pass real JS objects/arrays — not pre-stringified JSON.
/** Insert handle that accepts real JS objects/arrays for the JSON columns; the values are `JSON.stringify`'d automatically before binding. */
const insertBook = defineWrite({
  db,
  params: createInsertSchema(BookSchema),
  sql: `INSERT INTO books (book_id, title, metadata, tags)
        VALUES ($book_id, $title, $metadata, $tags)`,
})

insertBook.run({
  book_id: 'bk_1',
  title: 'Dune',
  metadata: { isbn: '978-0441013593', edition: 1 }, // stringified on write
  tags: ['scifi', 'classic'],
})

/** Read handle whose result is validated against {@link BookSchema}, so the JSON-backed `metadata` / `tags` columns are parsed and validated on the way out. */
const findBook = defineQuery({
  db,
  params: z.object({ book_id: z.string() }),
  result: BookSchema,
  sql: 'SELECT * FROM books WHERE book_id = $book_id',
})

/** Holds the read-back row to show the JSON round-trip: `metadata` and `tags` come back as parsed, typed values, not raw TEXT. */
const book = findBook.one({ book_id: 'bk_1' })
console.log(book?.metadata.isbn) // "978-0441013593" — parsed object, typed access
console.log(book?.tags) // [ "scifi", "classic" ] — parsed array

// Next: 06-full-table.ts — everything together on a realistic table.

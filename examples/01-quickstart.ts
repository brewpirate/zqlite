/**
 * 01 — Quickstart: schema → table → write → read, the whole loop.
 *
 * Run with:  bun examples/01-quickstart.ts
 *
 * The one idea behind zqlite: a single Zod schema is the source of truth
 * for your TypeScript types, your CREATE TABLE, and your query validation.
 * Define it once; everything else is derived.
 */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import { defineQuery, defineWrite, migrate, zodToSqliteDDL } from '../src/index'

// ── 1. One schema describes the table ───────────────────────────────────────
//
// New to Zod? A Zod schema is a runtime description of a value's shape.
// `z.infer<typeof Schema>` turns it into a TypeScript type for free.
// See https://zod.dev — you only need `z.object`, `z.string`, `z.number`,
// `z.boolean` to follow along here.

const BookSchema = z.object({
  book_id: z.string(),
  title: z.string(),
  pages: z.number().int(), // .int() → INTEGER column (plain number → REAL)
  finished: z.boolean(), // stored as 0/1, handed back as a real boolean
})

// The TypeScript type, derived from the schema — no parallel interface.
type Book = z.infer<typeof BookSchema>

// ── 2. Generate the table from the schema ───────────────────────────────────
//
// New to SQLite? It's a file-backed SQL database with no server. `bun:sqlite`
// ships with Bun, so `new Database(':memory:')` is a throwaway in-RAM database
// — perfect for examples. See https://bun.sh/docs/api/sqlite.

/** In-memory throwaway database so the quickstart runs without leaving a file on disk. */
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

// ── 3. A type-safe write ─────────────────────────────────────────────────────
//
// `defineWrite` compiles the statement once. `$book_id` etc. are named
// placeholders that match the `params` schema keys.

/** Compiled, type-safe INSERT handle; params are validated against {@link BookSchema} and `false` is serialized to 0 before binding. */
const insertBook = defineWrite({
  db,
  params: BookSchema,
  sql: `INSERT INTO books (book_id, title, pages, finished)
        VALUES ($book_id, $title, $pages, $finished)`,
})

// `finished: false` is serialized to 0 automatically before binding.
insertBook.run({ book_id: 'bk_1', title: 'Dune', pages: 412, finished: false })

// ── 4. A type-safe read ──────────────────────────────────────────────────────
//
// Params are validated before binding; the returned row is coerced (0 → false)
// and validated against `BookSchema` before you ever touch it.

/** Compiled, type-safe SELECT handle; the returned row is coerced (0 → false) and validated against {@link BookSchema} before it reaches the caller. */
const findBook = defineQuery({
  db,
  params: z.object({ book_id: z.string() }),
  result: BookSchema,
  sql: 'SELECT * FROM books WHERE book_id = $book_id',
})

/** The fetched row, already validated and coerced into a real {@link Book} (or null if no match) — note `finished` comes back as a boolean, not 0. */
const book: Book | null = findBook.one({ book_id: 'bk_1' })

console.log(book)
// { book_id: "bk_1", title: "Dune", pages: 412, finished: false }
//                                              ^ a real boolean, not 0

// Next: 02-writes.ts — transactions, batch writes, and insert schemas.

/**
 * 02 — Writes: defineWrite, transactions, and insert schemas.
 *
 * Run with:  bun examples/02-writes.ts
 *
 * `defineWrite` is the write-shaped sibling of `defineQuery`. It has no
 * `result` schema (writes don't return rows) and both its methods return the
 * driver's `{ changes, lastInsertRowid }`.
 *
 *   .run(params)             — execute outside any transaction
 *   .runInTransaction(params)— wrap this single statement in BEGIN IMMEDIATE
 *
 * For two or more writes that must be atomic, use `execWrite(db, () => …)`.
 */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  createInsertSchema,
  defineWrite,
  execWrite,
  migrate,
  zodToSqliteDDL,
} from '../src/index'

const BookSchema = z.object({
  book_id: z.string(),
  title: z.string(),
  pages: z.number().int(),
  finished: z.boolean().default(false), // DB-side default → optional on insert
  borrowed_by: z.string().nullable(), // nullable → optional on insert
})

/** In-memory throwaway DB; its `books` table carries defaulted and nullable columns so this example can demonstrate insert-shape derivation. */
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

// ── createInsertSchema: derive the insert shape from the base schema ─────────
//
// Nullable and defaulted fields become optional in the params, so callers can
// omit `finished` and `borrowed_by`. No hand-written `.omit()` / `.partial()`.

/** Insert-time param shape derived from {@link BookSchema}: nullable and defaulted columns become optional, so callers may omit `finished` and `borrowed_by` without a hand-written `.omit()`/`.partial()`. */
const BookInsertSchema = createInsertSchema(BookSchema)

// IMPORTANT: to let a column's SQL DEFAULT (or implicit NULL) apply, leave the
// column OUT of the INSERT column list. A defaulted column is emitted as
// `... NOT NULL DEFAULT 0` — if you list it and bind an omitted param, you'd
// bind NULL and violate NOT NULL. So this INSERT names only the columns it
// actually supplies; `finished` falls back to its DEFAULT, `borrowed_by` to NULL.
/** INSERT that lists only the columns it supplies, so the omitted `finished`/`borrowed_by` fall back to their SQL DEFAULT / NULL rather than binding NULL into a NOT NULL column — see the note above. */
const insertBook = defineWrite({
  db,
  params: BookInsertSchema,
  sql: `INSERT INTO books (book_id, title, pages)
        VALUES ($book_id, $title, $pages)`,
})

// ── .run() returns { changes, lastInsertRowid } ──────────────────────────────

/** Holds the driver's `{ changes, lastInsertRowid }` so the example can print how many rows the write affected. */
const result = insertBook.run({ book_id: 'bk_1', title: 'Dune', pages: 412 })
console.log('inserted rows:', result.changes) // 1

// ── .runInTransaction() — one statement, wrapped in BEGIN IMMEDIATE ──────────
//
// Use this instead of execWrite(db, () => x.run(...)) when it's a single write.
// BEGIN IMMEDIATE takes the write lock upfront so concurrent writers queue
// rather than racing into SQLITE_BUSY.

/** Single-statement update used to demonstrate `.runInTransaction`, which takes the write lock upfront via BEGIN IMMEDIATE. */
const markFinished = defineWrite({
  db,
  params: z.object({ book_id: z.string() }),
  sql: 'UPDATE books SET finished = 1 WHERE book_id = $book_id',
})

/** Captures the result so the example can print `changes` and show the single-statement transaction succeeded. */
const updated = markFinished.runInTransaction({ book_id: 'bk_1' })
console.log('updated rows:', updated.changes) // 1

// ── execWrite — two or more writes, atomically ───────────────────────────────
//
// Either both writes commit or neither does. The callback's return value is
// passed back through execWrite.

// `defineWrite` prepares its statement immediately, so every table it
// references must already exist — create `activity` before defining the handle.
db.query(
  'CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, detail TEXT)',
).run()

/** First write in the atomic pair below — updates the book; committed together with {@link logActivity} via `execWrite`. */
const lendBook = defineWrite({
  db,
  params: z.object({ book_id: z.string(), borrower: z.string() }),
  sql: 'UPDATE books SET borrowed_by = $borrower WHERE book_id = $book_id',
})
/** Second write in the atomic pair — pairing it with {@link lendBook} inside `execWrite` shows that either both commit or neither does. */
const logActivity = defineWrite({
  db,
  params: z.object({ detail: z.string() }),
  sql: 'INSERT INTO activity (detail) VALUES ($detail)',
})

execWrite(db, () => {
  lendBook.run({ book_id: 'bk_1', borrower: 'ada' })
  logActivity.run({ detail: 'bk_1 lent to ada' })
})
console.log('lent + logged atomically')

// Next: 03-dynamic-queries.ts — one handle for many WHERE / ORDER BY shapes.

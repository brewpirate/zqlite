/**
 * 03 — Dynamic queries: one handle for many WHERE / ORDER BY shapes.
 *
 * Run with:  bun examples/03-dynamic-queries.ts
 *
 * A list endpoint usually filters on different combinations of columns —
 * sometimes by author, sometimes only finished books, sometimes both. Two
 * tempting-but-bad answers:
 *
 *   1. `WHERE ($author IS NULL OR author = $author)` — defeats indexes,
 *      because the planner can't fold the constant away.
 *   2. One hand-written `defineQuery` per combination — combinatorial.
 *
 * `defineDynamicQuery` composes named fragments instead. You declare every
 * possible WHERE/ORDER BY fragment up front, then *activate* the ones you
 * want per call. Inactive fragments are omitted from the SQL entirely, so the
 * optimizer sees a real, prunable clause. Each unique shape compiles one
 * prepared statement, cached for reuse.
 */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  defineDynamicQuery,
  defineWrite,
  migrate,
  zodToSqliteDDL,
} from '../src/index'

const BookSchema = z.object({
  book_id: z.string(),
  title: z.string(),
  author: z.string(),
  pages: z.number().int(),
  finished: z.boolean(),
})

/** In-memory database so the dynamic-query example runs without touching disk; the table is created by the migration below. */
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

/** Insert handle used only to seed the fixture rows the dynamic-query examples read back. */
const insertBook = defineWrite({
  db,
  params: BookSchema,
  sql: `INSERT INTO books (book_id, title, author, pages, finished)
        VALUES ($book_id, $title, $author, $pages, $finished)`,
})
/** Fixture rows spanning two authors and both finished states, so the activation examples below have something to filter and order. */
const seed: z.infer<typeof BookSchema>[] = [
  {
    book_id: 'bk_1',
    title: 'Dune',
    author: 'Herbert',
    pages: 412,
    finished: true,
  },
  {
    book_id: 'bk_2',
    title: 'Dune Messiah',
    author: 'Herbert',
    pages: 256,
    finished: false,
  },
  {
    book_id: 'bk_3',
    title: 'Neuromancer',
    author: 'Gibson',
    pages: 271,
    finished: true,
  },
]
for (const book of seed) insertBook.run(book)

// ── Define the composable query ──────────────────────────────────────────────
//
// `where` and `order` are maps of *named fragments*. The keys become the
// activation vocabulary; `$param` placeholders reference the `params` schema.

/** The composable list query: every possible WHERE/ORDER fragment is declared once here, then activated per call so inactive clauses drop out of the SQL entirely. */
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
  order: {
    title: 'title ASC',
    longest: 'pages DESC',
  },
})

// ── Activate different shapes per call ───────────────────────────────────────

// No filters, no order → SELECT * FROM books
console.log(
  'all:',
  listBooks.all({ params: {} }).map((book) => book.title),
)

// One filter + order → SELECT … WHERE author = $author ORDER BY title ASC
console.log(
  'by Herbert, alphabetical:',
  listBooks
    .all({
      params: { author: 'Herbert' },
      where: ['byAuthor'],
      orderBy: 'title',
    })
    .map((book) => book.title),
)

// Two filters AND-joined + order → finished books over 300 pages, longest first
console.log(
  'finished & long, longest first:',
  listBooks
    .all({
      params: { min_pages: 300 },
      where: ['finished', 'longerThan'],
      orderBy: 'longest',
    })
    .map((book) => book.title),
)

// Activation order doesn't matter — ['finished','longerThan'] and
// ['longerThan','finished'] hit the same cached statement.

// Next: 04-migrations.ts — versioned + additive schema changes.

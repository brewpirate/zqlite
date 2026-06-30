/**
 * 04 — Migrations: versioned schema setup + additive column changes.
 *
 * Run with:  bun examples/04-migrations.ts
 *
 * Two complementary tools:
 *
 *   migrate(db, [...])     — versioned. Tracks applied versions in a
 *                            `schema_version` table; safe to call every
 *                            startup. Use for greenfield schema setup.
 *   migrateAddColumn(...)  — idempotent ALTER TABLE ADD COLUMN; no-ops if the
 *   migrateDropColumn(...)   column already exists / is already gone. Use for
 *                            additive changes to live tables.
 */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  migrate,
  migrateAddColumn,
  migrateDropColumn,
  zodToSqliteDDL,
} from '../src/index'

/** In-memory database so the migrations example runs without touching disk; it starts empty and is built up by the versioned migrations below. */
const db = new Database(':memory:')

// ── Versioned migrations ─────────────────────────────────────────────────────
//
// Each migration runs in its own transaction. `up` accepts a single SQL
// string, an ordered string[] (for multi-statement baselines, since
// db.prepare is single-statement), or a (db) => void callback.

/** The version-1 table shape — deliberately minimal so later steps can demonstrate additively widening a live table. */
const BookSchemaV1 = z.object({
  book_id: z.string(),
  title: z.string(),
})

migrate(db, [
  {
    version: 1,
    up: zodToSqliteDDL({
      table: 'books',
      schema: BookSchemaV1,
      primaryKey: ['book_id'],
    }),
  },
  // A later version adds an index + a sibling table in one ordered step.
  {
    version: 2,
    up: [
      'CREATE INDEX IF NOT EXISTS idx_books_title ON books(title)',
      'CREATE TABLE IF NOT EXISTS authors (author_id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    ],
  },
])

// Calling migrate again is a no-op — versions 1 and 2 are already applied.
migrate(db, [
  { version: 1, up: 'SELECT 1' },
  { version: 2, up: 'SELECT 1' },
])
console.log('migrations applied; re-running is safe')

// ── Additive column changes on a live table ──────────────────────────────────
//
// Idempotent: running these twice is harmless. `migrateAddColumn` throws
// MissingTableError if the table doesn't exist, so a typo fails loudly
// instead of silently no-op'ing.

migrateAddColumn({ db, table: 'books', column: 'pages', definition: 'INTEGER' })
migrateAddColumn({
  db,
  table: 'books',
  column: 'legacy_rating',
  definition: 'INTEGER',
})
console.log('added columns: pages, legacy_rating')

// ── Drop with optional backfill ──────────────────────────────────────────────
//
// The backfill SQL runs before the drop. Its WHERE guard makes the whole
// migration safe to retry — once `legacy_rating` is gone, the helper
// short-circuits and the backfill is skipped. Requires SQLite 3.35.0+.

migrateAddColumn({
  db,
  table: 'books',
  column: 'rating',
  definition: 'INTEGER',
})
migrateDropColumn({
  db,
  table: 'books',
  column: 'legacy_rating',
  backfill:
    'UPDATE books SET rating = legacy_rating WHERE rating IS NULL AND legacy_rating IS NOT NULL',
})
console.log('migrated legacy_rating → rating, then dropped the old column')

// Next: 05-json-columns.ts — storing typed objects and arrays as JSON.

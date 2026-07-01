/**
 * 06 — Full table: everything together on a realistic `sessions` table.
 *
 * Run with:  bun examples/06-full-table.ts
 *
 * A capstone combining the pieces from 01–05: a non-trivial schema (JSON,
 * boolean, date, nullable, defaulted), insert + update operation schemas,
 * a RETURNING write, and a transaction. This mirrors how the host project
 * (command-center) actually uses zqlite.
 */
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import {
  createInsertSchema,
  createUpdateSchema,
  defineQuery,
  defineWrite,
  execWrite,
  migrate,
  zJsonSchema,
  zodToSqliteDDL,
} from '../src/index'

// ── Schema ───────────────────────────────────────────────────────────────────

const SessionSchema = z.object({
  session_id: z.string(),
  cwd: z.string(),
  model: z.string(),
  total_tokens: z.number().int().nonnegative(),
  is_active: z.boolean().default(true), // DB default → optional on insert
  started_at: z.date(), // TEXT ISO 8601 ↔ Date
  ended_at: z.date().nullable(), // nullable → optional on insert
  metadata: zJsonSchema(
    z.object({ version: z.number(), tags: z.array(z.string()) }),
  ),
})

type Session = z.infer<typeof SessionSchema>

// Insert: nullable/defaulted fields optional, with a per-field refinement.
/** Insert-shaped params derived from {@link SessionSchema}: defaulted/nullable columns become optional, and `model` gets a length refinement layered on. */
const SessionInsertSchema = createInsertSchema(SessionSchema, {
  model: (schema: z.ZodString) => schema.min(1).max(100),
})

// Update (PATCH): every field optional; re-add the WHERE key as required.
/** PATCH-shaped params: all columns optional via `createUpdateSchema`, then `session_id` re-required because it is the WHERE key, not a settable field. */
const SessionUpdateSchema = createUpdateSchema(SessionSchema).extend({
  session_id: z.string(),
})

// ── Setup ─────────────────────────────────────────────────────────────────────
//
// Multi-driver note: this uses `bun:sqlite`. The same `db` works with
// `better-sqlite3` or `libsql` if you set `paramPrefix: ''` on the connection,
// or with Node's `node:sqlite` via a small adapter — see docs/recipes.md →
// "Multiple drivers". All four run the same test suite in CI.

/** In-memory database so this capstone example runs without touching disk; the schema is materialised by the migration below. */
const db = new Database(':memory:')
migrate(db, [
  {
    version: 1,
    up: zodToSqliteDDL({
      table: 'sessions',
      schema: SessionSchema,
      primaryKey: ['session_id'],
    }),
  },
])

// ── Queries ────────────────────────────────────────────────────────────────────

// `is_active` (defaulted) and `ended_at` (nullable) are left out of the column
// list so the DB DEFAULT / implicit NULL applies — see 02-writes.ts for why
// listing a defaulted column and binding an omitted param would violate NOT NULL.
/** Insert handle whose params come from {@link SessionInsertSchema}; the INSERT names only supplied columns so defaulted/nullable ones fall back server-side. */
const insertSession = defineWrite({
  db,
  params: SessionInsertSchema,
  sql: `INSERT INTO sessions (session_id, cwd, model, total_tokens, started_at, metadata)
        VALUES ($session_id, $cwd, $model, $total_tokens, $started_at, $metadata)`,
})

// A RETURNING write still uses defineQuery — it returns a row, so it needs a
// result schema. defineWrite is for writes that don't return rows.
/** Closes a session and returns the updated row in one round-trip; uses `defineQuery` rather than `defineWrite` because `RETURNING *` produces a row to validate. */
const endSession = defineQuery({
  db,
  params: SessionUpdateSchema,
  result: SessionSchema,
  sql: `UPDATE sessions SET is_active = 0, ended_at = $ended_at
        WHERE session_id = $session_id RETURNING *`,
})

/** Point read by primary key — the result is validated against {@link SessionSchema} so JSON, boolean, and date columns are decoded before the caller sees them. */
const findSession = defineQuery({
  db,
  params: z.object({ session_id: z.string() }),
  result: SessionSchema,
  sql: 'SELECT * FROM sessions WHERE session_id = $session_id',
})

// ── Usage ──────────────────────────────────────────────────────────────────────

// Single-statement write wrapped in a transaction.
insertSession.runInTransaction({
  session_id: 'sess_001',
  cwd: '/home/user/project',
  model: 'claude-sonnet-4-6',
  total_tokens: 1200,
  started_at: new Date('2026-01-01T10:00:00Z'),
  metadata: { version: 1, tags: ['demo', 'example'] },
  // is_active omitted → DB default (true); ended_at omitted → NULL
})

/** Reads the row back to show the boolean round-trip: `is_active` was stored as 1 and is handed back as `true`. */
const found: Session | null = findSession.one({ session_id: 'sess_001' })
console.log('active?', found?.is_active) // true — coerced from 1

// A RETURNING update inside execWrite so the read-back is in the same txn.
/** Demonstrates that a RETURNING write inside `execWrite` reads back the just-updated row atomically — `ended_at` comes back as a coerced Date. */
const ended = execWrite(db, () =>
  endSession.one({ session_id: 'sess_001', ended_at: new Date() }),
)
console.log('ended_at:', ended?.ended_at instanceof Date) // true — coerced to Date
console.log('tags:', found?.metadata.tags) // [ "demo", "example" ] — parsed JSON

/**
 * 07 — Turso cloud (async): the same schema, over the network.
 *
 * Run with:  bun examples/07-turso-cloud.ts
 *
 * Turso is remote and therefore asynchronous, so it uses zqlite's parallel
 * *async* API — `defineAsyncQuery`, `defineAsyncWrite`, `execWriteAsync` — over
 * `@libsql/client`. The schema, validation, and coercion are identical to the
 * synchronous drivers; the calls just return Promises.
 *
 * This example runs out of the box against a **local file** database. To point
 * it at real Turso cloud, set two env vars and re-run — nothing else changes:
 *
 *   TURSO_DATABASE_URL='libsql://<db>.turso.io' \
 *   TURSO_AUTH_TOKEN='<database auth token>' \
 *   bun examples/07-turso-cloud.ts
 *
 * TURSO_AUTH_TOKEN must be a *database auth token* (`turso db tokens create <db>`),
 * not a Turso Platform API token — see docs/turso.md.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { z } from 'zod'
import {
  createInsertSchema,
  defineAsyncQuery,
  defineAsyncWrite,
  execWriteAsync,
  zJsonSchema,
  zodToSqliteDDL,
  type AsyncSqliteAdapter,
} from '../src/index'

// Real Turso when the env vars are set; otherwise a local file so the example
// runs with no setup. `@libsql/client`'s Client satisfies AsyncSqliteAdapter as-is.
const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN
const usingTurso = Boolean(url && authToken)
const db = createClient(
  usingTurso
    ? { url: url as string, authToken }
    : { url: `file:${join(tmpdir(), 'zqlite-example-turso.db')}` },
) as unknown as AsyncSqliteAdapter

console.log(
  usingTurso
    ? '→ connected to Turso cloud'
    : '→ no TURSO_* env vars; running against a local file DB (set them to use real Turso)',
)

// ── Schema ───────────────────────────────────────────────────────────────────

const NoteSchema = z.object({
  note_id: z.string(),
  title: z.string(),
  pinned: z.boolean(), // 0/1 in SQLite ↔ boolean here
  created_at: z.date(), // TEXT ISO 8601 ↔ Date
  labels: zJsonSchema(z.array(z.string())), // JSON TEXT ↔ string[]
})

// ── Setup ─────────────────────────────────────────────────────────────────────

// DDL runs through the connection's own execute(); zodToSqliteDDL is shared with
// the sync path. Drop-if-exists keeps the example idempotent across re-runs.
await db.execute({ sql: 'DROP TABLE IF EXISTS notes', args: {} })
await db.execute({
  sql: zodToSqliteDDL({ table: 'notes', schema: NoteSchema, primaryKey: ['note_id'] }),
  args: {},
})

// ── Handles ──────────────────────────────────────────────────────────────────

const insertNote = defineAsyncWrite({
  db,
  params: createInsertSchema(NoteSchema),
  sql: `INSERT INTO notes (note_id, title, pinned, created_at, labels)
        VALUES ($note_id, $title, $pinned, $created_at, $labels)`,
})

const findNote = defineAsyncQuery({
  db,
  params: z.object({ note_id: z.string() }),
  result: NoteSchema,
  sql: 'SELECT * FROM notes WHERE note_id = $note_id',
})

const logActivity = defineAsyncWrite({
  db,
  params: createInsertSchema(NoteSchema),
  sql: `INSERT INTO notes (note_id, title, pinned, created_at, labels)
        VALUES ($note_id, $title, $pinned, $created_at, $labels)`,
})

// ── Usage ──────────────────────────────────────────────────────────────────────

// A single async write.
const writeResult = await insertNote.run({
  note_id: 'n1',
  title: 'Buy milk',
  pinned: true,
  created_at: new Date('2026-01-01T09:00:00Z'),
  labels: ['errand', 'home'],
})
console.log('inserted:', writeResult.changes, 'row')

// Read it back — booleans, Dates, and JSON come back as real types.
const note = await findNote.one({ note_id: 'n1' })
console.log('pinned?', note?.pinned) // true — coerced from 1
console.log('labels:', note?.labels) // [ "errand", "home" ] — parsed JSON
console.log('created_at is Date?', note?.created_at instanceof Date) // true

// Two writes, atomically, over the wire. execWriteAsync opens an interactive
// transaction and hands it to the callback; run handles against `tx` to enlist
// them. Either both commit or neither does.
await execWriteAsync(db, async (tx) => {
  await insertNote.run(
    {
      note_id: 'n2',
      title: 'Call the vet',
      pinned: false,
      created_at: new Date('2026-01-01T10:00:00Z'),
      labels: ['pet'],
    },
    tx,
  )
  await logActivity.run(
    {
      note_id: 'n3',
      title: 'note n2 created',
      pinned: false,
      created_at: new Date('2026-01-01T10:00:01Z'),
      labels: ['audit'],
    },
    tx,
  )
})
console.log('committed 2 rows atomically')

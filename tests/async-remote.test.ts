/**
 * Credentialed integration test for the async API against a real remote Turso
 * database. This is the committed, reproducible counterpart to the local
 * `async.test.ts` — it exercises the same primitives over the network so the
 * "works against live Turso" claim has an artifact anyone can inspect and re-run.
 *
 * It SKIPS unless both DB_URL and DB_TOKEN are set (Bun auto-loads `.env`), so
 * CI — which has no secrets — passes without running it. To run it locally:
 *
 *   DB_URL='libsql://<db>.turso.io' DB_TOKEN='<database auth token>' bun test tests/async-remote.test.ts
 *
 * DB_TOKEN must be a *database auth token* (authenticates the libsql:// data
 * connection), NOT a Turso *Platform API token* (org/management scopes) — the
 * latter returns HTTP 401. Mint one with `turso db tokens create <db>`.
 *
 * Good-guest: one throwaway table (`zqlite_async_remote_test`), dropped before
 * and after (in afterAll), and never logs the URL or token.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient } from '@libsql/client'
import { z } from 'zod'
import {
  type AsyncSqliteAdapter,
  createInsertSchema,
  defineAsyncQuery,
  defineAsyncWrite,
  execWriteAsync,
  zJsonSchema,
  zodToSqliteDDL,
} from '../src/index'

const url = process.env.DB_URL
const authToken = process.env.DB_TOKEN
const hasCredentials = Boolean(url && authToken)

const TABLE = 'zqlite_async_remote_test'
const RecordSchema = z.object({
  id: z.string(),
  count: z.number().int(),
  active: z.boolean(),
  created_at: z.date(),
  meta: zJsonSchema(z.object({ tag: z.string() })),
})
const FIXED_INSTANT = new Date('2024-01-02T03:04:05.000Z')

// Constructed lazily inside the guarded block so the file imports cleanly (and
// skips) when no credentials are present.
let client: AsyncSqliteAdapter

describe.skipIf(!hasCredentials)('async API against live Turso', () => {
  beforeAll(async () => {
    // biome-ignore lint/style/noNonNullAssertion: guarded by hasCredentials.
    client = createClient({ url: url!, authToken: authToken! }) as unknown as AsyncSqliteAdapter
    await client.execute({ sql: `DROP TABLE IF EXISTS ${TABLE}`, args: {} })
    await client.execute({
      sql: zodToSqliteDDL({ table: TABLE, schema: RecordSchema, primaryKey: ['id'] }),
      args: {},
    })
  })

  afterAll(async () => {
    if (hasCredentials) {
      await client.execute({ sql: `DROP TABLE IF EXISTS ${TABLE}`, args: {} })
    }
  })

  const insert = () =>
    defineAsyncWrite({
      db: client,
      params: createInsertSchema(RecordSchema),
      sql: `INSERT INTO ${TABLE} (id, count, active, created_at, meta)
            VALUES ($id, $count, $active, $created_at, $meta)`,
    })
  const countRows = () =>
    defineAsyncQuery({
      db: client,
      params: z.object({}),
      result: z.object({ total: z.number().int() }),
      sql: `SELECT COUNT(*) AS total FROM ${TABLE}`,
    })

  test('write + read coerce over the network', async () => {
    await insert().run({
      id: 'one',
      count: 7,
      active: true,
      created_at: FIXED_INSTANT,
      meta: { tag: 'alpha' },
    })
    const findById = defineAsyncQuery({
      db: client,
      params: z.object({ id: z.string() }),
      result: RecordSchema,
      sql: `SELECT * FROM ${TABLE} WHERE id = $id`,
    })
    expect(await findById.one({ id: 'one' })).toEqual({
      id: 'one',
      count: 7,
      active: true,
      created_at: FIXED_INSTANT,
      meta: { tag: 'alpha' },
    })
  })

  test('execWriteAsync commits a multi-write transaction on the server', async () => {
    const before = (await countRows().one({}))?.total ?? 0
    await execWriteAsync(client, async (tx) => {
      await insert().run(
        { id: 'c1', count: 1, active: true, created_at: FIXED_INSTANT, meta: { tag: 'commit' } },
        tx,
      )
      await insert().run(
        { id: 'c2', count: 2, active: false, created_at: FIXED_INSTANT, meta: { tag: 'commit' } },
        tx,
      )
    })
    expect((await countRows().one({}))?.total).toBe(before + 2)
  })

  test('execWriteAsync rolls back on the server when the callback throws', async () => {
    const before = (await countRows().one({}))?.total ?? 0
    await expect(
      execWriteAsync(client, async (tx) => {
        await insert().run(
          { id: 'r1', count: 9, active: true, created_at: FIXED_INSTANT, meta: { tag: 'rollback' } },
          tx,
        )
        throw new Error('forced remote rollback')
      }),
    ).rejects.toThrow('forced remote rollback')

    // Server-side atomicity: the pre-throw write must not have persisted
    // remotely — the rollback reached the server, not just the JS client. (This
    // proves all-or-nothing atomicity over the wire, not isolation between
    // concurrent transactions, which would need two racing clients.)
    expect((await countRows().one({}))?.total).toBe(before)
    const findById = defineAsyncQuery({
      db: client,
      params: z.object({ id: z.string() }),
      result: RecordSchema,
      sql: `SELECT * FROM ${TABLE} WHERE id = $id`,
    })
    expect(await findById.one({ id: 'r1' })).toBeNull()
  })
})

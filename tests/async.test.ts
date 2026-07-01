import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  type AsyncSqliteAdapter,
  createInsertSchema,
  defineAsyncQuery,
  defineAsyncWrite,
  execWriteAsync,
  PlaceholderMismatchError,
  zJsonSchema,
  zodToSqliteDDL,
} from '../src/index'

// A file DB, not :memory: — @libsql/client gives each :memory: execute a fresh
// connection, so a table created in one call is invisible to the next and
// transactions can't see it. A real Turso URL is one logical DB, like this file.
const DB_PATH = join(tmpdir(), 'zqlite-async-test.db')
const client = createClient({
  url: `file:${DB_PATH}`,
}) as unknown as AsyncSqliteAdapter

const TABLE = 'records'
const RecordSchema = z.object({
  id: z.string(),
  count: z.number().int(),
  active: z.boolean(),
  created_at: z.date(),
  meta: zJsonSchema(z.object({ tag: z.string() })),
})
const FIXED_INSTANT = new Date('2024-01-02T03:04:05.000Z')

beforeEach(async () => {
  await client.execute({ sql: `DROP TABLE IF EXISTS ${TABLE}`, args: {} })
  await client.execute({
    sql: zodToSqliteDDL({ table: TABLE, schema: RecordSchema, primaryKey: ['id'] }),
    args: {},
  })
})

afterAll(() => {
  // The file DB persists on disk between runs; remove it and its WAL sidecars.
  for (const suffix of ['', '-shm', '-wal']) {
    rmSync(`${DB_PATH}${suffix}`, { force: true })
  }
})

const insertWrite = defineAsyncWrite({
  db: client,
  params: createInsertSchema(RecordSchema),
  sql: `INSERT INTO ${TABLE} (id, count, active, created_at, meta)
        VALUES ($id, $count, $active, $created_at, $meta)`,
})

const countRows = defineAsyncQuery({
  db: client,
  params: z.object({}),
  result: z.object({ total: z.number().int() }),
  sql: `SELECT COUNT(*) AS total FROM ${TABLE}`,
})

describe('defineAsyncQuery', () => {
  test('coerces a single row back to its schema types on read', async () => {
    await insertWrite.run({
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
    const row = await findById.one({ id: 'one' })

    // Booleans, Dates, and JSON come back as real types — via the shared sync core.
    expect(row).toEqual({
      id: 'one',
      count: 7,
      active: true,
      created_at: FIXED_INSTANT,
      meta: { tag: 'alpha' },
    })
  })

  test('resolves to null from .one() when no row matches', async () => {
    const findById = defineAsyncQuery({
      db: client,
      params: z.object({ id: z.string() }),
      result: RecordSchema,
      sql: `SELECT * FROM ${TABLE} WHERE id = $id`,
    })
    expect(await findById.one({ id: 'missing' })).toBeNull()
  })

  test('coerces every row from .all()', async () => {
    await insertWrite.run({
      id: 'a',
      count: 1,
      active: true,
      created_at: FIXED_INSTANT,
      meta: { tag: 'first' },
    })
    await insertWrite.run({
      id: 'b',
      count: 2,
      active: false,
      created_at: FIXED_INSTANT,
      meta: { tag: 'second' },
    })

    const listAll = defineAsyncQuery({
      db: client,
      params: z.object({}),
      result: RecordSchema,
      sql: `SELECT * FROM ${TABLE} ORDER BY id`,
    })
    const rows = await listAll.all({})

    expect(rows.length).toBe(2)
    expect(rows[0]?.active).toBe(true)
    expect(rows[1]?.active).toBe(false)
  })
})

describe('defineAsyncWrite', () => {
  test('reports driver-native { changes, lastInsertRowid } from a write', async () => {
    const result = await insertWrite.run({
      id: 'w',
      count: 3,
      active: false,
      created_at: FIXED_INSTANT,
      meta: { tag: 'write' },
    })
    expect(result.changes).toBe(1)
    expect(Number(result.lastInsertRowid)).toBeGreaterThanOrEqual(1)
  })
})

describe('execWriteAsync', () => {
  test('commits a multi-statement transaction', async () => {
    await execWriteAsync(client, async (tx) => {
      await insertWrite.run(
        { id: 'c1', count: 1, active: true, created_at: FIXED_INSTANT, meta: { tag: 'commit' } },
        tx,
      )
      await insertWrite.run(
        { id: 'c2', count: 2, active: true, created_at: FIXED_INSTANT, meta: { tag: 'commit' } },
        tx,
      )
    })
    expect((await countRows.one({}))?.total).toBe(2)
  })

  test('rolls back the transaction when the callback throws', async () => {
    const sentinel = 'forced async rollback'
    await expect(
      execWriteAsync(client, async (tx) => {
        await insertWrite.run(
          { id: 'r1', count: 1, active: true, created_at: FIXED_INSTANT, meta: { tag: 'rollback' } },
          tx,
        )
        throw new Error(sentinel)
      }),
    ).rejects.toThrow(sentinel)

    // The pre-throw write must not survive the rollback.
    expect((await countRows.one({}))?.total).toBe(0)
  })
})

describe('placeholder check (parity with the sync path)', () => {
  test('throws PlaceholderMismatchError on a non-$name placeholder at define time', () => {
    expect(() =>
      defineAsyncQuery({
        db: client,
        params: z.object({ id: z.string() }),
        result: RecordSchema,
        sql: `SELECT * FROM ${TABLE} WHERE id = :id`,
      }),
    ).toThrow(PlaceholderMismatchError)
  })

  test('throws when a $name placeholder has no matching params key', () => {
    expect(() =>
      defineAsyncWrite({
        db: client,
        params: z.object({ id: z.string() }),
        sql: `DELETE FROM ${TABLE} WHERE id = $wrong`,
      }),
    ).toThrow(PlaceholderMismatchError)
  })
})

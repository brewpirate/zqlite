import assert from 'node:assert'
import { z } from 'zod'
import type { SqliteAdapter } from '../../src/types'
import type { IntegrationAdapter } from './adapters'

/**
 * The shared, driver-agnostic integration suite.
 *
 * This is a *parity* check, not a re-test of every behavior — the comprehensive
 * bun-specific coverage lives in `tests/zqlite.test.ts` and is deliberately
 * left untouched. Here the goal is narrow: prove that the behaviors which route
 * through the {@link SqliteAdapter} boundary — param binding, row coercion,
 * driver-reported write results, and transaction commit/rollback — are
 * *identical* across every driver in every runtime.
 *
 * The suite is parameterized three ways so one body serves every cell:
 *
 * - **by adapter** — the caller passes the {@link IntegrationAdapter} for the
 *   driver under test;
 * - **by test runner** — the caller injects `describe` / `test` / `beforeEach`
 *   from its runtime's runner (`bun:test` under Bun, `node:test` under Node).
 *   Assertions do *not* need injecting: both runtimes implement `node:assert`,
 *   so the suite uses it directly rather than depending on either runner's
 *   `expect`;
 * - **by library build** — the caller passes the zqlite module itself, so the
 *   same suite can run against the TypeScript source (`import * from
 *   '../../src/index'`) for the fast inner loop, or against the compiled,
 *   published artifact (`import * from 'zqlite'`, resolved through the package
 *   `exports` map to `dist/`) to verify what consumers actually install.
 *
 * All assertions use strict equality (`strictEqual` / `deepStrictEqual`).
 * Loose `assert.equal` would treat `1 == true`, hiding the exact "boolean comes
 * back as 0/1" coercion bug this suite exists to catch.
 */

/**
 * The test-runner primitives the suite registers against. Bun's `bun:test` and
 * Node's `node:test` both export functions with these shapes, so the suite can
 * be written once and wired to whichever runner the runtime provides.
 */
export interface TestRunnerApi {
  describe: (name: string, body: () => void) => void
  test: (name: string, body: () => void) => void
  beforeEach: (body: () => void) => void
}

/**
 * The set of zqlite exports the suite exercises at runtime, captured as the
 * module's own type. Injecting the module (rather than importing it directly)
 * is what lets the same suite run against either the source or the compiled
 * `dist/` build — the caller decides which by passing the matching import.
 *
 * This is a type-only construct (`typeof import(...)`), so it adds no runtime
 * dependency on the source from this file.
 */
export type ZqliteModule = typeof import('../../src/index')

/** Table the suite creates fresh in every test. */
const TABLE_NAME = 'records'

/** A fixed Date so coercion assertions compare against a known instant. */
const FIXED_INSTANT = new Date('2024-01-02T03:04:05.000Z')

/**
 * Registers the full parity suite for one driver against one test runner, using
 * the supplied zqlite build. Call once per available adapter from the runtime's
 * entry file.
 *
 * @param adapter - The driver cell under test (supplies a fresh DB per test).
 * @param runner - The runtime's test-runner primitives.
 * @param zqlite - The zqlite build under test (source module or compiled dist).
 */
export function defineIntegrationSuite(
  adapter: IntegrationAdapter,
  runner: TestRunnerApi,
  zqlite: ZqliteModule,
): void {
  const { describe, test, beforeEach } = runner
  const {
    configureZqliteAdapter,
    createInsertSchema,
    defineQuery,
    defineWrite,
    execWrite,
    zJsonSchema,
    zodToSqliteDDL,
  } = zqlite

  /**
   * The schema under test. Chosen to exercise every coercion that crosses the
   * driver boundary, because those are exactly the behaviors that could diverge
   * between drivers:
   *
   * - `active` (boolean ↔ 0/1) — the canonical "comes back as 0, not false" bug;
   * - `created_at` (Date ↔ ISO string) — stored as TEXT, parsed back to a Date;
   * - `meta` (JSON ↔ object) — stored as TEXT, parsed back to an object.
   *
   * Built inside the suite (not at module scope) because `zJsonSchema` comes
   * from the injected build under test.
   */
  const RecordSchema = z.object({
    id: z.string(),
    count: z.number().int(),
    active: z.boolean(),
    created_at: z.date(),
    meta: zJsonSchema(z.object({ tag: z.string() })),
  })

  /** Params schema shared by the single-row reads. */
  const IdParamsSchema = z.object({ id: z.string() })

  /**
   * Inserts one fully-specified row via `defineWrite`. Returns the driver's
   * reported write result so tests can assert on `changes` / `lastInsertRowid`.
   *
   * createInsertSchema swaps the read-side JSON pipe (string -> object) for the
   * underlying object schema, so writes accept `meta` as an object; serializeRow
   * stringifies it before binding. Using RecordSchema directly here would reject
   * the object because zJsonSchema parses in the read direction (string -> object).
   */
  function insertRecord(
    db: SqliteAdapter,
    values: z.infer<typeof RecordSchema>,
  ): { changes: number; lastInsertRowid: number | bigint } {
    const writeRecord = defineWrite({
      db,
      params: createInsertSchema(RecordSchema),
      sql: `INSERT INTO ${TABLE_NAME} (id, count, active, created_at, meta)
            VALUES ($id, $count, $active, $created_at, $meta)`,
    })
    return writeRecord.run(values)
  }

  describe(`driver parity — ${adapter.name}`, () => {
    let db: SqliteAdapter

    beforeEach(() => {
      db = adapter.makeDb()
      configureZqliteAdapter(db)
      const ddl = zodToSqliteDDL({
        table: TABLE_NAME,
        schema: RecordSchema,
        primaryKey: ['id'],
      })
      db.prepare(ddl).run()
    })

    test('coerces a single row back to its schema types on read', () => {
      insertRecord(db, {
        id: 'one',
        count: 7,
        active: true,
        created_at: FIXED_INSTANT,
        meta: { tag: 'alpha' },
      })

      const findById = defineQuery({
        db,
        params: IdParamsSchema,
        result: RecordSchema,
        sql: `SELECT * FROM ${TABLE_NAME} WHERE id = $id`,
      })
      const row = findById.one({ id: 'one' })

      // The whole point: booleans, Dates, and JSON come back as real types,
      // not 0/1, ISO strings, and raw JSON text — on every driver.
      assert.deepStrictEqual(row, {
        id: 'one',
        count: 7,
        active: true,
        created_at: FIXED_INSTANT,
        meta: { tag: 'alpha' },
      })
    })

    test('returns null from .one() when no row matches', () => {
      const findById = defineQuery({
        db,
        params: IdParamsSchema,
        result: RecordSchema,
        sql: `SELECT * FROM ${TABLE_NAME} WHERE id = $id`,
      })
      assert.strictEqual(findById.one({ id: 'missing' }), null)
    })

    test('coerces every row from .all()', () => {
      insertRecord(db, {
        id: 'a',
        count: 1,
        active: true,
        created_at: FIXED_INSTANT,
        meta: { tag: 'first' },
      })
      insertRecord(db, {
        id: 'b',
        count: 2,
        active: false,
        created_at: FIXED_INSTANT,
        meta: { tag: 'second' },
      })

      const listAll = defineQuery({
        db,
        params: z.object({}),
        result: RecordSchema,
        sql: `SELECT * FROM ${TABLE_NAME} ORDER BY id`,
      })
      const rows = listAll.all({})

      assert.strictEqual(rows.length, 2)
      assert.strictEqual(rows[0]?.active, true)
      assert.strictEqual(rows[1]?.active, false)
    })

    test('reports driver-native { changes, lastInsertRowid } from a write', () => {
      const result = insertRecord(db, {
        id: 'w',
        count: 3,
        active: false,
        created_at: FIXED_INSTANT,
        meta: { tag: 'write' },
      })

      assert.strictEqual(result.changes, 1)
      // lastInsertRowid is number under default integer mode and bigint under
      // safeIntegers; the row is the first insert, so it equals 1 either way.
      assert.strictEqual(Number(result.lastInsertRowid), 1)
    })

    test('commits a multi-statement execWrite block', () => {
      execWrite(db, () => {
        insertRecord(db, {
          id: 'c1',
          count: 1,
          active: true,
          created_at: FIXED_INSTANT,
          meta: { tag: 'commit' },
        })
        insertRecord(db, {
          id: 'c2',
          count: 2,
          active: true,
          created_at: FIXED_INSTANT,
          meta: { tag: 'commit' },
        })
      })

      const countRows = defineQuery({
        db,
        params: z.object({}),
        result: z.object({ total: z.number().int() }),
        sql: `SELECT COUNT(*) AS total FROM ${TABLE_NAME}`,
      })
      assert.strictEqual(countRows.one({})?.total, 2)
    })

    test('rolls back an execWrite block when its callback throws', () => {
      const sentinelMessage = 'forced rollback'

      assert.throws(() => {
        execWrite(db, () => {
          insertRecord(db, {
            id: 'r1',
            count: 1,
            active: true,
            created_at: FIXED_INSTANT,
            meta: { tag: 'rollback' },
          })
          throw new Error(sentinelMessage)
        })
      }, new RegExp(sentinelMessage))

      // The insert before the throw must not survive — proves BEGIN IMMEDIATE /
      // ROLLBACK works the same on every driver, including the node:sqlite
      // wrapper that hand-rolls transactions.
      const countRows = defineQuery({
        db,
        params: z.object({}),
        result: z.object({ total: z.number().int() }),
        sql: `SELECT COUNT(*) AS total FROM ${TABLE_NAME}`,
      })
      assert.strictEqual(countRows.one({})?.total, 0)
    })
  })
}

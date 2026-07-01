import type { SqliteAdapter } from '../../src/types'

/**
 * Cross-runtime, cross-driver adapter registry for the integration suite.
 *
 * zqlite is driver-agnostic: everything routes through the {@link SqliteAdapter}
 * interface. The integration suite proves that *identical behavior* holds on
 * every driver in every runtime that can host it — so this module's job is to
 * report which (runtime, driver) cells are actually available right now and
 * hand back a factory for each.
 *
 * The available cells are intentionally sparse — no driver runs everywhere:
 *
 * | Runtime | bun:sqlite | better-sqlite3      | node:sqlite | libsql |
 * |---------|------------|---------------------|-------------|--------|
 * | Bun     | yes        | no — Bun rejects it | no          | yes    |
 * | Node 22+| no         | yes                 | yes         | yes    |
 *
 * Two rules follow from that table and are load-bearing:
 *
 * 1. **Dynamic import only.** A static `import 'bun:sqlite'` crashes Node at
 *    parse time, and a static `import 'node:sqlite'` crashes Bun. Every driver
 *    is reached via `await import(...)` inside a guard so a runtime only ever
 *    touches the modules it actually has.
 * 2. **Probe by constructing, not by importing.** `better-sqlite3`'s JS module
 *    imports fine under Bun — it is the native addon *construction* that throws
 *    `'better-sqlite3' is not yet supported in Bun`. So availability is decided
 *    by actually opening (and closing) a throwaway connection, not by whether
 *    the import resolved.
 */

/** Path passed to every driver to open a private, throwaway in-memory database. */
const MEMORY_DATABASE_PATH = ':memory:'

/**
 * A driver that is available in the current runtime, paired with a factory that
 * returns a fresh, unconfigured {@link SqliteAdapter} on each call. The suite
 * calls `makeDb` in `beforeEach` so every test gets an isolated database.
 */
export interface IntegrationAdapter {
  /** Human-readable driver label, e.g. `'bun:sqlite'`. Used in test names. */
  name: string
  /** Opens a fresh in-memory connection for one test. */
  makeDb: () => SqliteAdapter
}

/**
 * The subset of Node's `DatabaseSync` that the {@link adaptNodeSqlite} wrapper
 * uses. Declared structurally rather than imported from `node:sqlite` so this
 * file still parses under Bun, where that module does not exist.
 */
interface NodeSqliteDatabase {
  prepare(sql: string): unknown
  exec(sql: string): void
}

/**
 * Wraps Node's `DatabaseSync` to satisfy {@link SqliteAdapter}. `DatabaseSync`
 * has no `.transaction()` method, so this supplies one with explicit
 * `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` — matching the isolation level
 * zqlite's write path assumes. Also sets `paramPrefix: ''` because `node:sqlite`
 * binds bare keys (`{ name }`), not `$name` keys. This mirrors the wrapper
 * documented in `docs/recipes.md`.
 */
function adaptNodeSqlite(database: NodeSqliteDatabase): SqliteAdapter {
  return {
    paramPrefix: '',
    prepare: (sql) =>
      database.prepare(sql) as ReturnType<SqliteAdapter['prepare']>,
    exec: (sql) => database.exec(sql),
    transaction: (callback) => () => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = callback()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

/**
 * The subset of libsql's `Database` the {@link adaptLibsql} wrapper uses.
 * Declared structurally so this file needs no static libsql import.
 */
interface LibsqlDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  exec(sql: string): void
  transaction<CallbackResult>(callback: () => CallbackResult): () => CallbackResult
}

/**
 * Removes libsql's injected `_metadata` key from a result row, in place. Rows
 * are plain mutable objects, so an in-place `delete` avoids copying; the
 * `'_metadata' in row` guard makes it a no-op for rows that lack the key.
 */
function stripLibsqlMetadata(row: unknown): unknown {
  if (row !== null && typeof row === 'object' && '_metadata' in row) {
    delete (row as Record<string, unknown>)._metadata
  }
  return row
}

/**
 * Wraps libsql's `Database` to satisfy {@link SqliteAdapter}. Two adjustments:
 *
 * - `paramPrefix: ''` — libsql binds bare keys (`{ name }`), like better-sqlite3.
 * - **strips `_metadata`** — libsql injects a `_metadata` field into rows
 *   returned by `.get()`. zqlite's default (non-strict) Zod objects drop it, but
 *   a `.strict()` result schema would reject it with a QueryValidationError.
 *   Removing it at the boundary makes libsql behave identically to the other
 *   drivers for every schema shape. `.all()` rows are unaffected by libsql today
 *   but pass through the same strip defensively.
 */
function adaptLibsql(database: LibsqlDatabase): SqliteAdapter {
  return {
    paramPrefix: '',
    exec: (sql) => database.exec(sql),
    transaction: (callback) => database.transaction(callback),
    prepare: (sql) => {
      const statement = database.prepare(sql)
      return {
        get: (...params: unknown[]) =>
          stripLibsqlMetadata(statement.get(...params)),
        all: (...params: unknown[]) =>
          statement.all(...params).map(stripLibsqlMetadata),
        run: (...params: unknown[]) => statement.run(...params),
      } as ReturnType<SqliteAdapter['prepare']>
    },
  }
}

/**
 * Returns the `bun:sqlite` cell, or `null` when not in the Bun runtime.
 * Pass `new Database(path)` straight through — bun:sqlite needs no wrapper and
 * uses the default `$name` param prefix.
 */
async function tryBunSqlite(): Promise<IntegrationAdapter | null> {
  const hasBunGlobal =
    typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (!hasBunGlobal) {
    return null
  }
  try {
    const { Database } = await import('bun:sqlite')
    return {
      name: 'bun:sqlite',
      makeDb: () =>
        new Database(MEMORY_DATABASE_PATH) as unknown as SqliteAdapter,
    }
  } catch {
    return null
  }
}

/**
 * Returns the `better-sqlite3` cell, or `null` when the driver cannot be
 * constructed in this runtime. Under Bun the import resolves but construction
 * throws, so a throwaway connection is opened and closed to prove usability
 * before the cell is reported available. `paramPrefix: ''` is required —
 * without it every named param silently binds NULL.
 */
async function tryBetterSqlite3(): Promise<IntegrationAdapter | null> {
  try {
    const module = await import('better-sqlite3')
    const BetterSqlite3Database = module.default
    // Construct-and-close probe: importing is not enough — Bun only fails when
    // the native addon is actually instantiated.
    new BetterSqlite3Database(MEMORY_DATABASE_PATH).close()
    return {
      name: 'better-sqlite3',
      makeDb: () =>
        Object.assign(new BetterSqlite3Database(MEMORY_DATABASE_PATH), {
          paramPrefix: '',
        }) as unknown as SqliteAdapter,
    }
  } catch {
    return null
  }
}

/**
 * Returns the `node:sqlite` cell, or `null` when the module is absent (Bun, or
 * Node older than 22). Wraps `DatabaseSync` via {@link adaptNodeSqlite} to add
 * the missing `.transaction()` method.
 */
async function tryNodeSqlite(): Promise<IntegrationAdapter | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return {
      name: 'node:sqlite',
      makeDb: () => adaptNodeSqlite(new DatabaseSync(MEMORY_DATABASE_PATH)),
    }
  } catch {
    return null
  }
}

/**
 * Returns the `libsql` cell, or `null` when the driver cannot be constructed.
 * `libsql` (Turso's fork) ships a synchronous, better-sqlite3-compatible
 * `Database` and — unlike `better-sqlite3` — its native addon loads under BOTH
 * Bun and Node, so this cell runs in every runtime. Constructed via the same
 * open-and-close probe as `better-sqlite3` in case a future runtime rejects the
 * addon at construction. Wrapped with {@link adaptLibsql} for `paramPrefix: ''`
 * and to strip libsql's injected `_metadata` field.
 *
 * Only the local/in-memory mode is exercised here — that fully satisfies
 * `SqliteAdapter`. Turso cloud (remote or embedded replica) is out of scope for
 * this suite; see `spikes/libsql-turso/` for that investigation.
 */
async function tryLibsql(): Promise<IntegrationAdapter | null> {
  try {
    const module = await import('libsql')
    const LibsqlConstructor = module.default
    new LibsqlConstructor(MEMORY_DATABASE_PATH).close()
    return {
      name: 'libsql',
      makeDb: () =>
        adaptLibsql(
          new LibsqlConstructor(
            MEMORY_DATABASE_PATH,
          ) as unknown as LibsqlDatabase,
        ),
    }
  } catch {
    return null
  }
}

/**
 * Probes every driver and returns the cells available in the current runtime.
 * Callers iterate the result and register the shared suite once per adapter.
 *
 * Never returns an empty array silently in a healthy environment — each runtime
 * has at least one driver. A caller that gets zero adapters should treat that
 * as a misconfiguration, not a pass.
 */
export async function getAvailableAdapters(): Promise<IntegrationAdapter[]> {
  const candidates = await Promise.all([
    tryBunSqlite(),
    tryBetterSqlite3(),
    tryNodeSqlite(),
    tryLibsql(),
  ])
  return candidates.filter(
    (candidate): candidate is IntegrationAdapter => candidate !== null,
  )
}

/**
 * Fails loudly when the drivers actually available do not match what this
 * runtime is expected to host. This is the load-bearing guard of the whole
 * effort: without it, a driver that silently fails to load (e.g. a broken
 * `better-sqlite3` native build in CI) would shrink the parity check to fewer
 * cells while the run still reported green — making "green with fewer drivers
 * than intended" indistinguishable from "green". The cross-driver guarantee is
 * exactly what this work exists to protect, so a missing expected driver is a
 * hard failure, not a silent skip.
 *
 * Logs the drivers that ran (and any unexpected extras) so the covered cells
 * are visible in the test output, then throws if any expected driver is absent.
 *
 * @param available - Drivers the probe found usable in this runtime.
 * @param expectedNames - Drivers this runtime is required to exercise.
 * @param runtimeLabel - Human-readable runtime name for the message, e.g. `'Bun'`.
 */
export function assertExpectedAdapters(
  available: IntegrationAdapter[],
  expectedNames: string[],
  runtimeLabel: string,
): void {
  const availableNames = available.map((adapter) => adapter.name)
  console.log(
    `[${runtimeLabel}] driver-parity cells running: ${availableNames.join(', ') || '(none)'}`,
  )

  const missing = expectedNames.filter((name) => !availableNames.includes(name))
  if (missing.length > 0) {
    throw new Error(
      `[${runtimeLabel}] expected SQLite drivers are unavailable: ${missing.join(', ')}. ` +
        `Available: ${availableNames.join(', ') || '(none)'}. ` +
        'A missing expected driver shrinks the parity check silently — failing instead.',
    )
  }
}

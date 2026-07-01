import type { SqliteAdapter } from './types.js'

/**
 * Knobs accepted by {@link configureZqliteAdapter}. All optional — omit any
 * field to inherit zqlite's default. Callers that want bespoke values for
 * `synchronous` or `journalMode` can pass them; the defaults below are the
 * ones zqlite's read/write story assumes (WAL + NORMAL sync for concurrent
 * reads alongside writes; 5s busy timeout for the BEGIN IMMEDIATE retry
 * window in `execWrite`).
 */
export interface ConfigureZqliteAdapterOpts {
  /**
   * Whether to enable foreign-key enforcement. SQLite ships with FKs off
   * by default; production schemas with FK declarations need this on.
   * Tests often leave it off so fixture rows can sit in isolation without
   * cascading constraint setup.
   */
  foreignKeys?: boolean
  /**
   * SQLite journaling mode. Default `'WAL'` — the only mode that lets
   * concurrent reads proceed while a writer holds the reserved lock,
   * which is the model `execWrite`'s `BEGIN IMMEDIATE` semantics assume.
   */
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF'
  /**
   * `synchronous` PRAGMA. Default `'NORMAL'` — the recommended setting for
   * WAL mode (safe across application crashes; only loses durability on a
   * power-loss within the WAL checkpoint window, which is an explicit
   * tradeoff for write throughput).
   */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'
  /**
   * `busy_timeout` in milliseconds. Default `5000` — long enough that
   * `BEGIN IMMEDIATE` in `execWrite` can wait out a concurrent writer
   * holding the reserved lock without the caller hand-rolling retries.
   */
  busyTimeoutMs?: number
}

/**
 * Applies the PRAGMAs that zqlite's read/write machinery assumes on the
 * adapter — WAL journaling, NORMAL synchronous, busy timeout, and
 * optionally foreign keys. Call once on a freshly-constructed adapter
 * before handing it to {@link defineQuery} / {@link execWrite} / {@link migrate}.
 *
 * The PRAGMAs map onto specific zqlite assumptions:
 *
 * - **WAL** — required for concurrent reads alongside writes. `execWrite`'s
 *   `BEGIN IMMEDIATE` model relies on readers not blocking on the reserved
 *   lock, which only holds under WAL.
 * - **synchronous=NORMAL** — paired with WAL, gives the standard
 *   "durable to application crash, may lose last txn on power loss"
 *   tradeoff. The other levels are valid but match different durability
 *   budgets.
 * - **busy_timeout=5000ms** — the retry window for `BEGIN IMMEDIATE`
 *   when a writer is already holding the reserved lock. Without it,
 *   `SQLITE_BUSY` would surface to the caller instantly under contention.
 * - **foreign_keys** — opt-in. Production schemas with FK declarations need
 *   it on; tests usually leave it off so fixture rows can sit in isolation.
 *
 * Splitting this out of `getDb()`-style helpers in consumer packages means
 * a future driver swap (Bun → Node sqlite, better-sqlite3, etc.) doesn't
 * have to re-derive the same PRAGMA list — the adapter contract carries it.
 *
 * @param db - A freshly-constructed `SqliteAdapter` (typically a `Database`
 *   from `bun:sqlite` or `better-sqlite3`) — caller owns construction
 * @param opts - PRAGMA overrides; omit any field to take zqlite's default
 */
export function configureZqliteAdapter(
  db: SqliteAdapter,
  opts: ConfigureZqliteAdapterOpts = {},
): void {
  const journalMode = opts.journalMode ?? 'WAL'
  const synchronous = opts.synchronous ?? 'NORMAL'
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000
  const foreignKeys = opts.foreignKeys ?? false

  // PRAGMAs are issued as one-shot statements, NOT via `prepare(...).run()`.
  // `PRAGMA journal_mode` and `PRAGMA busy_timeout` return a row; some drivers
  // (notably libsql) leave that statement's cursor open after `.run()`, and the
  // open cursor makes the next `COMMIT` fail with "cannot commit transaction -
  // SQL statements in progress". A one-shot exec has no lingering cursor.
  runConfigurationStatement(db, `PRAGMA journal_mode = ${journalMode}`)
  runConfigurationStatement(db, `PRAGMA synchronous = ${synchronous}`)
  runConfigurationStatement(db, `PRAGMA busy_timeout = ${busyTimeoutMs}`)
  if (foreignKeys) {
    runConfigurationStatement(db, 'PRAGMA foreign_keys = ON')
  }
}

/** A driver connection that additionally exposes bun:sqlite's `run(sql)`. */
interface ConnectionWithRun {
  run(sql: string): unknown
}

/**
 * Returns `true` when the connection exposes a connection-level `run(sql)`.
 * Only `bun:sqlite` does; `better-sqlite3`, `node:sqlite`, and `libsql` expose
 * `run` on prepared statements, not on the connection.
 */
function hasConnectionRun(db: SqliteAdapter): db is SqliteAdapter & ConnectionWithRun {
  return (
    typeof (db as Partial<ConnectionWithRun>).run === 'function'
  )
}

/**
 * Executes one setup PRAGMA as a one-shot statement, choosing the method that
 * avoids a deprecated path per driver:
 *
 * - `bun:sqlite` deprecated `Database.exec` in favor of `Database.run`, and it
 *   is the only driver with a connection-level `run` — so prefer `run` there.
 * - `better-sqlite3`, `node:sqlite`, and `libsql` expose `exec` (not a
 *   connection-level `run`), so fall back to the `exec` guaranteed by
 *   {@link SqliteAdapter}.
 *
 * Either way the PRAGMA runs as a one-shot with no lingering cursor.
 */
function runConfigurationStatement(db: SqliteAdapter, sql: string): void {
  if (hasConnectionRun(db)) {
    db.run(sql)
    return
  }
  db.exec(sql)
}

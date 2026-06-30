import { TransactionRollbackError } from './errors'
import type { SqliteAdapter } from './types'

/**
 * Wraps a write in `BEGIN IMMEDIATE` so concurrent writers queue on the
 * reserved lock rather than racing and failing with SQLITE_BUSY mid-statement.
 *
 * Required when multiple async paths write to the same WAL-mode database.
 * Uses explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` rather than the
 * driver's `.transaction()` helper so the IMMEDIATE isolation level is
 * guaranteed regardless of driver defaults.
 *
 * On failure: catches the callback's error, attempts `ROLLBACK`, then
 * re-throws the original error. If `ROLLBACK` itself fails the database may
 * be in an indeterminate state — a {@link TransactionRollbackError} is
 * thrown carrying both the trigger and the rollback failure.
 *
 * @param db - The SQLite database connection
 * @param writeOperations - Synchronous write operations to execute atomically
 * @returns The return value of `writeOperations`
 *
 * @throws {@link TransactionRollbackError} when both the callback and
 *   `ROLLBACK` fail. Otherwise re-throws the callback's original error.
 */
export function execWrite<CallbackResult>(
  db: SqliteAdapter,
  writeOperations: () => CallbackResult,
): CallbackResult {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    const result = writeOperations()
    db.prepare('COMMIT').run()
    return result
  } catch (originalError) {
    try {
      db.prepare('ROLLBACK').run()
    } catch (rollbackError) {
      throw new TransactionRollbackError(originalError, rollbackError)
    }
    throw originalError
  }
}

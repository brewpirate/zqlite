/**
 * The set of types Bun's SQLite driver accepts as bound parameter values.
 * Everything else must be serialized to one of these before binding.
 *
 * Driver note: `bigint` is bindable directly under `bun:sqlite`. Under
 * `better-sqlite3` it requires `safeIntegers: true` on the database; without
 * that flag the driver throws on bind. The union stays driver-agnostic — the
 * caveat lives here so consumers swapping drivers know to flip the flag.
 */
export type SqliteBindable =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array

/**
 * Converts a single JavaScript value to a SQLite-bindable primitive.
 *
 * SQLite has no native boolean or Date type, so this normalizes across the
 * boundary: `Date` → ISO 8601 string (matching `z.date()` TEXT storage),
 * `boolean` → `1`/`0` integer, objects and arrays → JSON string. All other
 * primitives pass through unchanged.
 *
 * @param value - Any value from a validated params object
 * @returns A value safe to bind directly to a prepared statement
 */
export function serializeValue(value: unknown): SqliteBindable {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

/**
 * Applies {@link serializeValue} to every value in a params object, producing
 * a record safe to pass directly to `.get()`, `.all()`, or `.run()`.
 *
 * Called by {@link defineQuery} after Zod validates the params and before
 * binding to the prepared statement.
 *
 * @param row - A validated params object with named keys
 * @returns The same keys mapped to SQLite-bindable values
 */
export function serializeRow(
  row: Record<string, unknown>,
): Record<string, SqliteBindable> {
  const serialized: Record<string, SqliteBindable> = {}
  for (const [key, value] of Object.entries(row)) {
    serialized[key] = serializeValue(value)
  }
  return serialized
}

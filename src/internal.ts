import { z } from 'zod'
import type { SqliteBindable } from './serialize'

/** Shorthand for Zod 4's base type — the common ground of all schema shapes. */
type AnyZodType = z.core.$ZodType

/** Per-field row coercer: maps a column key to a value transformer. */
type FieldCoercer = { key: string; coerce: (value: unknown) => unknown }

/**
 * Applies the driver's param key prefix to a serialized params object.
 * `bun:sqlite` requires `{ $name: value }` for `$name` placeholders;
 * `better-sqlite3` requires `{ name: value }` (no prefix). Passing the wrong
 * format silently binds nothing — no error, every param becomes NULL.
 *
 * Shared between `defineQuery` and `defineDynamicQuery`. Was originally
 * inlined in `query.ts`; extracted here when `defineDynamicQuery` arrived
 * and the duplication crossed the 3rd-call threshold (`defineWrite` reuses
 * `query.ts`'s copy structurally, `defineDynamicQuery` would be #3).
 */
export function prefixParamKeys(
  row: Record<string, SqliteBindable>,
  prefix: string,
): Record<string, SqliteBindable> {
  if (prefix === '') return row
  const prefixed: Record<string, SqliteBindable> = {}
  for (const [columnKey, bindableValue] of Object.entries(row)) {
    prefixed[`${prefix}${columnKey}`] = bindableValue
  }
  return prefixed
}

/**
 * Strips `ZodOptional`, `ZodNullable`, and `ZodDefault` wrappers to reach
 * the underlying concrete type. Needed so type-dispatch logic (instanceof
 * checks) works regardless of how a field is decorated.
 */
function unwrapType(type: AnyZodType): AnyZodType {
  if (
    type instanceof z.ZodOptional ||
    type instanceof z.ZodNullable ||
    type instanceof z.ZodDefault
  ) {
    return unwrapType(type.def.innerType as AnyZodType)
  }
  return type
}

/**
 * Builds a row coercer from the result schema, executed once per query
 * definition. SQLite returns booleans as `0`/`1` integers and dates as ISO
 * strings — Zod's strict `boolean` and `date` types reject those raw values,
 * so we coerce before parsing.
 *
 * Only inspects `ZodObject` schemas; returns a no-op for scalar result types.
 *
 * Shared between `defineQuery` and `defineDynamicQuery` — both run rows
 * through `result.parse()` after coercion.
 */
export function buildRowCoercer(
  schema: z.ZodType,
): (row: Record<string, unknown>) => Record<string, unknown> {
  if (!(schema instanceof z.ZodObject))
    return (row: Record<string, unknown>): Record<string, unknown> => row

  const fieldCoercers: FieldCoercer[] = []

  for (const [columnKey, fieldType] of Object.entries(schema.shape)) {
    const inner = unwrapType(fieldType)
    if (inner instanceof z.ZodBoolean) {
      fieldCoercers.push({
        key: columnKey,
        coerce: (rawColumnValue: unknown): unknown =>
          rawColumnValue === 1 || rawColumnValue === true,
      })
    } else if (inner instanceof z.ZodDate) {
      fieldCoercers.push({
        key: columnKey,
        coerce: (rawColumnValue: unknown): unknown =>
          typeof rawColumnValue === 'string'
            ? new Date(rawColumnValue)
            : rawColumnValue,
      })
    }
  }

  if (fieldCoercers.length === 0)
    return (row: Record<string, unknown>): Record<string, unknown> => row

  return (row: Record<string, unknown>): Record<string, unknown> => {
    const coerced = { ...row }
    for (const { key: columnKey, coerce } of fieldCoercers) {
      if (columnKey in coerced) coerced[columnKey] = coerce(coerced[columnKey])
    }
    return coerced
  }
}

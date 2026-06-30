import { z } from 'zod'

export function zSqliteBool(): z.ZodLiteral<0 | 1>
export function zSqliteBool(
  defaultValue: 0 | 1,
): z.ZodDefault<z.ZodLiteral<0 | 1>>
/**
 * Zod schema for SQLite columns that store booleans as `0`/`1` INTEGER.
 *
 * Tightens the parse layer to reject non-binary integers
 * (`requires_approval: 2` no longer slips past) and emits a
 * `CHECK(col IN (0, 1))` constraint at the SQL layer via the existing
 * `zodToSqliteDDL` multi-value-literal path.
 * Inferred type is `0 | 1`, so reading callsites narrow correctly without
 * runtime overhead.
 *
 * Implemented as `z.literal([0, 1])` rather than
 * `z.union([z.literal(0), z.literal(1)])` because the DDL emitter already
 * handles multi-value `ZodLiteral` (numeric `INTEGER` column type +
 * `IN (...)` CHECK clause); a union form would require new DDL paths for
 * no benefit.
 *
 * @param defaultValue - Optional `0` or `1` default. When provided, the
 * column emits `DEFAULT N` and parsing accepts `undefined` as that value.
 */
export function zSqliteBool(
  defaultValue?: 0 | 1,
): z.ZodLiteral<0 | 1> | z.ZodDefault<z.ZodLiteral<0 | 1>> {
  const literal = z.literal([0, 1])
  return defaultValue !== undefined ? literal.default(defaultValue) : literal
}

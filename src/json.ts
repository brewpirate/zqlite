import { z } from 'zod'

/**
 * Maps each JSON-column pipe to the inner Zod schema callers passed to
 * `zJsonSchema`. Used by `createInsertSchema` and `createUpdateSchema` to
 * replace the read-side string-parsing pipe with the underlying object type,
 * so insert/update params accept JS objects rather than JSON strings.
 *
 * Keyed on `z.core.$ZodType` (the base interface shared by all Zod schemas)
 * because shape values are typed as `$ZodType` in Zod 4's internal hierarchy.
 */
const JSON_COLUMN_REGISTRY = new WeakMap<z.core.$ZodType, z.core.$ZodType>()

/**
 * Returns `true` if `type` was created by {@link zJsonSchema} or
 * {@link zJsonArray}. Used by {@link zodToSqliteDDL} to emit `TEXT` for JSON
 * columns without requiring a separate `jsonColumns` option.
 *
 * @param type - The Zod type to check, typically after unwrapping optionals
 */
export function isJsonColumn(type: z.core.$ZodType): boolean {
  return JSON_COLUMN_REGISTRY.has(type)
}

/**
 * Returns the inner schema associated with a JSON column pipe, or `undefined`
 * if the type was not created by {@link zJsonSchema} / {@link zJsonArray}.
 * Used by the schema factory to replace the read-side pipe with the write-side
 * object type in insert and update schemas.
 *
 * @param type - The Zod type to look up
 */
export function getJsonColumnSchema(
  type: z.core.$ZodType,
): z.core.$ZodType | undefined {
  return JSON_COLUMN_REGISTRY.get(type)
}

/**
 * Schema for a JSON TEXT column whose stored value is a valid instance of
 * `schema`. On read, transparently JSON-parses the raw string and validates
 * the result. On write, {@link serializeRow} JSON-stringifies the value.
 *
 * Use this instead of `z.object()` or `z.array()` directly on a schema field
 * so the DDL generator knows to emit `TEXT` and the query wrapper knows to
 * parse the string back to a typed value.
 *
 * For insert and update params, `createInsertSchema` and `createUpdateSchema`
 * automatically replace this pipe with the underlying object type so callers
 * pass JS objects rather than JSON strings.
 *
 * @param schema - The Zod schema that the parsed JSON must satisfy
 * @param defaultValue - Returned when the stored value is an empty string
 */
export function zJsonSchema<ParsedValue>(
  schema: z.ZodType<ParsedValue>,
  defaultValue?: ParsedValue,
): z.ZodPipe<z.ZodString, z.ZodTransform<ParsedValue, string>> {
  const pipe = z.string().transform((value, context): ParsedValue => {
    if (value === '' && defaultValue !== undefined) return defaultValue
    try {
      return schema.parse(JSON.parse(value))
    } catch (error) {
      context.addIssue({ code: 'custom', message: (error as Error).message })
      return z.NEVER
    }
  })
  JSON_COLUMN_REGISTRY.set(pipe, schema)
  return pipe
}

/**
 * Schema for a JSON TEXT column that stores an untyped array. On read,
 * transparently JSON-parses the raw string. On write, {@link serializeRow}
 * JSON-stringifies the value.
 *
 * Prefer {@link zJsonSchema} with an explicit element schema when the array
 * shape is known — this variant skips element validation.
 *
 * @param defaultValue - Returned when the stored value is an empty string;
 * defaults to `[]`
 */
export function zJsonArray<Element>(
  defaultValue?: Element[],
): z.ZodPipe<z.ZodString, z.ZodTransform<Element[], string>> {
  const pipe = z.string().transform((value, context): Element[] => {
    if (value === '') return defaultValue ?? []
    try {
      return JSON.parse(value)
    } catch (error) {
      context.addIssue({ code: 'custom', message: (error as Error).message })
      return z.NEVER
    }
  })
  JSON_COLUMN_REGISTRY.set(pipe, z.array(z.unknown()))
  return pipe
}

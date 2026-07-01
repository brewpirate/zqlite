import { z } from 'zod'
import { getJsonColumnSchema, isJsonColumn } from './json.js'

/** Shorthand for Zod 4's base type — the common ground of all schema shapes. */
type AnyZodType = z.core.$ZodType

/**
 * A per-field refinement: either a replacement schema or a function that
 * receives the operation-transformed schema and returns a tightened version.
 * Applied after the optionality transform so refinements target the correct
 * wrapper (e.g. `ZodOptional<ZodString>` for a nullable insert field).
 *
 * Uses `z.core.$ZodType` as the base because Zod 4 types shape values at
 * the `$ZodType` level — concrete schemas satisfy this at runtime.
 */
export type RefineFunction<FieldSchema extends AnyZodType = AnyZodType> =
  | AnyZodType
  | ((schema: FieldSchema) => AnyZodType)

/**
 * Maps each key in a schema shape to an optional per-field refinement,
 * preserving the original field type for the callback parameter.
 */
export type Refine<SchemaShape extends z.ZodRawShape> = {
  [Key in keyof SchemaShape]?: RefineFunction<SchemaShape[Key]>
}

/**
 * Maps a single field type to its insert variant:
 * - Already optional → unchanged
 * - Nullable → wrapped in `ZodOptional` (can be omitted, stored as NULL)
 * - Has a default → inner type wrapped in `ZodOptional` (DB supplies value)
 * - Required → unchanged (must be provided)
 *
 * Branch order is load-bearing. Zod 4's wrappers can nest in either order
 * (`ZodOptional<ZodNullable<…>>` and `ZodNullable<ZodOptional<…>>` both
 * appear in user schemas), so `ZodOptional` is checked first to short-circuit
 * any optional-shaped field; only then is `ZodNullable` considered. `ZodDefault`
 * is checked last because a defaulted field is conceptually neither
 * optional nor nullable but still needs to become optional at the insert
 * boundary so callers can rely on the DB value.
 */
export type InsertField<FieldSchema extends AnyZodType> =
  FieldSchema extends z.ZodOptional<AnyZodType>
    ? FieldSchema
    : FieldSchema extends z.ZodNullable<AnyZodType>
      ? z.ZodOptional<FieldSchema>
      : FieldSchema extends z.ZodDefault<infer Inner extends AnyZodType>
        ? z.ZodOptional<Inner>
        : FieldSchema

/**
 * Maps a single field type to its update variant: already-optional fields
 * are unchanged; all others are wrapped in `ZodOptional` since PATCH
 * operations only require the fields being changed.
 */
export type UpdateField<FieldSchema extends AnyZodType> =
  FieldSchema extends z.ZodOptional<AnyZodType>
    ? FieldSchema
    : z.ZodOptional<FieldSchema>

/** Full insert shape derived from a base schema shape. */
export type InsertShape<SchemaShape extends z.ZodRawShape> = {
  [Key in keyof SchemaShape]: InsertField<SchemaShape[Key]>
}

/** Full update shape derived from a base schema shape. */
export type UpdateShape<SchemaShape extends z.ZodRawShape> = {
  [Key in keyof SchemaShape]: UpdateField<SchemaShape[Key]>
}

/**
 * Applies a refinement to a schema: calls the function if it is one, or
 * returns the replacement schema directly.
 */
function applyRefinement(
  schema: AnyZodType,
  refinement: RefineFunction,
): AnyZodType {
  return typeof refinement === 'function' ? refinement(schema) : refinement
}

/**
 * Returns the base schema unchanged, with optional per-field refinements
 * applied. Use for SELECT results where nullability is expressed directly in
 * the schema and every field is always present in a returned row.
 *
 * @param schema - The canonical base schema
 * @param refine - Optional per-field replacements or transform functions
 */
export function createSelectSchema<
  TableSchema extends z.ZodObject<z.ZodRawShape>,
>(
  schema: TableSchema,
  refine: Refine<TableSchema['shape']> = {},
): z.ZodObject<TableSchema['shape']> {
  const shape: Record<string, AnyZodType> = {}
  for (const [key, fieldType] of Object.entries(schema.shape)) {
    const refinement = (refine as Record<string, RefineFunction>)[key]
    shape[key] = refinement ? applyRefinement(fieldType, refinement) : fieldType
  }
  return z.object(shape) as z.ZodObject<TableSchema['shape']>
}

/**
 * Derives an INSERT schema from the base schema, making nullable and
 * defaulted fields optional. Callers omit nullable fields (stored as NULL)
 * or fields the DB/application will supply via a default.
 *
 * Refinements are applied after the optionality transform, so a `min(1)`
 * on a nullable field constrains the already-optional wrapped type.
 *
 * @param schema - The canonical base schema
 * @param refine - Optional per-field replacements or transform functions
 */
export function createInsertSchema<
  TableSchema extends z.ZodObject<z.ZodRawShape>,
>(
  schema: TableSchema,
  refine: Refine<TableSchema['shape']> = {},
): z.ZodObject<InsertShape<TableSchema['shape']>> {
  const shape: Record<string, AnyZodType> = {}
  for (const [key, fieldType] of Object.entries(schema.shape)) {
    const insertType = toInsertField(fieldType)
    const refinement = (refine as Record<string, RefineFunction>)[key]
    shape[key] = refinement
      ? applyRefinement(insertType, refinement)
      : insertType
  }
  return z.object(shape) as z.ZodObject<InsertShape<TableSchema['shape']>>
}

/**
 * Derives an UPDATE (PATCH) schema from the base schema, making every field
 * optional. Only the fields being changed need to be provided; unspecified
 * fields are left untouched in the database.
 *
 * Because all fields are optional, callers typically `.extend()` the result
 * to re-add any required WHERE-clause keys (e.g. `session_id`).
 *
 * @remarks
 * The returned schema validates `{}` successfully — an empty SET clause or,
 * worse, an UPDATE with no WHERE binding can update every row in the table.
 * The convention is therefore to **always** `.extend({ id: ... })` (or the
 * equivalent primary key) on the result before passing to {@link defineQuery},
 * so the WHERE column is required at the type level. This is enforced by
 * convention, not by the type system — review every call site.
 *
 * @param schema - The canonical base schema
 * @param refine - Optional per-field replacements or transform functions
 */
export function createUpdateSchema<
  TableSchema extends z.ZodObject<z.ZodRawShape>,
>(
  schema: TableSchema,
  refine: Refine<TableSchema['shape']> = {},
): z.ZodObject<UpdateShape<TableSchema['shape']>> {
  const shape: Record<string, AnyZodType> = {}
  for (const [key, fieldType] of Object.entries(schema.shape)) {
    const updateType = toUpdateField(fieldType)
    const refinement = (refine as Record<string, RefineFunction>)[key]
    shape[key] = refinement
      ? applyRefinement(updateType, refinement)
      : updateType
  }
  return z.object(shape) as z.ZodObject<UpdateShape<TableSchema['shape']>>
}

/**
 * Transforms a field type to its insert variant at runtime, mirroring
 * the compile-time {@link InsertField} conditional type.
 *
 * JSON column pipes (`zJsonSchema` / `zJsonArray`) are replaced with their
 * underlying object schema so insert params accept JS values rather than
 * JSON strings — `serializeRow` handles stringification before binding.
 */
function toInsertField(fieldType: AnyZodType): AnyZodType {
  if (fieldType instanceof z.ZodOptional) {
    const inner = fieldType.def.innerType as AnyZodType
    const unwrapped = resolveJsonColumn(inner)
    return unwrapped !== inner ? z.optional(unwrapped) : fieldType
  }
  if (fieldType instanceof z.ZodNullable) {
    const inner = fieldType.def.innerType as AnyZodType
    const unwrapped = resolveJsonColumn(inner)
    return unwrapped !== inner
      ? z.optional(z.nullable(unwrapped))
      : z.optional(fieldType)
  }
  if (fieldType instanceof z.ZodDefault) {
    return z.optional(fieldType.def.innerType as AnyZodType)
  }
  return resolveJsonColumn(fieldType)
}

/**
 * If `type` is a JSON column pipe, returns the inner schema registered for
 * write-side validation. Otherwise returns `type` unchanged.
 */
function resolveJsonColumn(type: AnyZodType): AnyZodType {
  if (isJsonColumn(type)) return getJsonColumnSchema(type) ?? type
  return type
}

/**
 * Transforms a field type to its update variant at runtime, mirroring
 * the compile-time {@link UpdateField} conditional type. Guards against
 * double-wrapping already-optional fields.
 */
function toUpdateField(fieldType: AnyZodType): AnyZodType {
  if (fieldType instanceof z.ZodOptional) return fieldType
  return z.optional(fieldType)
}

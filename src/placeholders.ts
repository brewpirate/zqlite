import { z } from 'zod'
import { PlaceholderMismatchError } from './errors.js'

// `console` is a universal runtime global (node, bun, browsers), but the build
// config (`tsconfig.build.json`) sets `types: []` to keep the emitted `.d.ts`
// free of ambient node/bun types — which also drops the global `console`
// declaration. Declare the one method used here so the build typechecks
// without pulling a full environment lib.
declare const console: { warn: (...args: unknown[]) => void }

/**
 * SQL/params cross-check, run once per `define*` call at definition time.
 *
 * The highest-value bug this catches is the one a Bun-first test suite
 * structurally cannot: a query whose `$name` placeholder does not match its
 * params key binds NULL *silently* on `bun:sqlite`, so green Bun tests pass —
 * yet the same query *throws* on `node:sqlite` and `better-sqlite3`. A Node
 * consumer hits the failure the Bun suite never surfaced. This check makes that
 * drift a uniform, eager error on every driver. It also catches `$name` typos
 * that the type system cannot see (the SQL string and the schema keys are
 * unrelated types).
 *
 * The check is name-correspondence only — it does not validate SQL syntax,
 * column existence, or value types.
 */

/** `$name` placeholder — the only binding syntax zqlite's `$`-keyed path fills. */
const DOLLAR_PLACEHOLDER = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g

/**
 * `:name` / `@name` / `?` / `?NNN` placeholder syntaxes SQLite accepts but that
 * zqlite's `$`-keyed binding does NOT fill — they would silently bind NULL.
 * The leading negative lookbehind avoids matching `::` casts and `@` inside
 * already-consumed tokens.
 */
const FOREIGN_PLACEHOLDER = /(?<![:@?\w])[:@][a-zA-Z_]\w*|\?\d*/g

/**
 * Removes string literals, quoted identifiers, and comments so a `$name` (or
 * `:name`, `?`) appearing *inside* them is not mistaken for a real placeholder.
 * This is a pragmatic backstop, not a full SQL lexer — the same posture as the
 * `;`-check in {@link InvalidColumnDefinitionError}. Because a stripper bug
 * would otherwise turn valid SQL into a definition-time crash with no recourse,
 * every `define*` call also accepts `skipPlaceholderCheck` to bypass the check
 * entirely.
 *
 * @param sql - Raw SQL statement text.
 * @returns The SQL with literal/comment spans blanked out.
 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted string literals
    .replace(/"(?:[^"]|"")*"/g, '""') // double-quoted identifiers
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
}

/**
 * Extracts the distinct `$name` placeholder names from a SQL statement,
 * ignoring any that appear inside string literals or comments.
 *
 * @param sql - Raw SQL statement text.
 * @returns The set of placeholder names (without the leading `$`).
 */
function extractDollarNames(sql: string): Set<string> {
  const clean = stripLiteralsAndComments(sql)
  const names = new Set<string>()
  for (const match of clean.matchAll(DOLLAR_PLACEHOLDER)) {
    names.add(match[1] as string)
  }
  return names
}

/**
 * Extracts the unsupported placeholder tokens (`:name`, `@name`, `?`, `?NNN`)
 * from a SQL statement, ignoring any inside string literals or comments.
 *
 * @param sql - Raw SQL statement text.
 * @returns The matched foreign placeholder tokens, in source order.
 */
function extractForeignPlaceholders(sql: string): string[] {
  const clean = stripLiteralsAndComments(sql)
  return [...clean.matchAll(FOREIGN_PLACEHOLDER)].map((match) => match[0])
}

/**
 * The param keys of a ZodObject, split into all keys and the subset that is
 * optional. A `ZodOptional` field left unbound is the documented DB-default
 * fall-through pattern, so it is exempt from the unused-param warning.
 *
 * @param paramSchema - The params schema passed to a `define*` function.
 */
function readParamKeys(paramSchema: z.ZodObject<z.ZodRawShape>): {
  allKeys: string[]
  optionalKeys: Set<string>
} {
  const allKeys: string[] = []
  const optionalKeys = new Set<string>()
  for (const [key, fieldType] of Object.entries(paramSchema.shape)) {
    allKeys.push(key)
    if (fieldType instanceof z.ZodOptional) optionalKeys.add(key)
  }
  return { allKeys, optionalKeys }
}

/**
 * Emits the unused-param warning for required params that the SQL never binds.
 * Required-and-unused is a likely leftover or typo worth surfacing; optional-
 * and-unused is the documented `createInsertSchema` partial-INSERT pattern and
 * is stayed silent.
 *
 * @param sql - The SQL statement (for the message).
 * @param unusedRequiredParams - Required param keys with no matching placeholder.
 */
function warnUnusedRequiredParams(
  sql: string,
  unusedRequiredParams: string[],
): void {
  if (unusedRequiredParams.length === 0) return
  console.warn(
    `[zqlite] params declared but never bound in SQL: ${unusedRequiredParams.join(', ')}. ` +
      `If intentional (e.g. a shared params object), ignore this. SQL: ${sql}`,
  )
}

/**
 * Cross-checks a static SQL statement against its params schema, for
 * {@link defineQuery} and {@link defineWrite}. Both directions are checked:
 *
 * - A `$name` placeholder with no matching param key throws
 *   {@link PlaceholderMismatchError} (silent NULL-bind on `bun:sqlite`).
 * - A foreign placeholder syntax throws (silent NULL-bind).
 * - A *required* param key with no placeholder warns; an *optional* one is
 *   silent (the documented DB-default fall-through pattern).
 *
 * @param sql - The SQL statement.
 * @param paramSchema - The params schema whose keys must match the placeholders.
 * @param skip - When true, the check is bypassed entirely (escape hatch for a
 *   stripper false-positive on otherwise-valid SQL).
 */
export function assertStaticPlaceholders(
  sql: string,
  paramSchema: z.ZodObject<z.ZodRawShape>,
  skip: boolean | undefined,
): void {
  if (skip) return
  const placeholders = extractDollarNames(sql)
  const { allKeys, optionalKeys } = readParamKeys(paramSchema)
  const keySet = new Set(allKeys)

  const missingParams = [...placeholders].filter((name) => !keySet.has(name))
  const foreignPlaceholders = extractForeignPlaceholders(sql)
  if (missingParams.length > 0 || foreignPlaceholders.length > 0) {
    throw new PlaceholderMismatchError({
      sql,
      missingParams,
      foreignPlaceholders,
    })
  }

  const unusedRequiredParams = allKeys.filter(
    (key) => !(placeholders.has(key) || optionalKeys.has(key)),
  )
  warnUnusedRequiredParams(sql, unusedRequiredParams)
}

/**
 * Cross-checks a composed dynamic query against its params schema, for
 * {@link defineDynamicQuery}. Only the missing/foreign directions are checked,
 * against the *union* of placeholders across the base SQL and every `where` /
 * `order` fragment — a param that serves a fragment which is not always active
 * is legitimately absent from the base SQL, so the unused direction would
 * false-positive here and is skipped.
 *
 * @param baseSql - The base SELECT without WHERE / ORDER BY.
 * @param fragments - Every `where` and `order` fragment value.
 * @param paramSchema - The params schema whose keys must cover all placeholders.
 * @param skip - When true, the check is bypassed entirely.
 */
export function assertDynamicPlaceholders(
  baseSql: string,
  fragments: string[],
  paramSchema: z.ZodObject<z.ZodRawShape>,
  skip: boolean | undefined,
): void {
  if (skip) return
  const { allKeys } = readParamKeys(paramSchema)
  const keySet = new Set(allKeys)

  const allPlaceholders = new Set<string>()
  const foreignPlaceholders: string[] = []
  for (const source of [baseSql, ...fragments]) {
    for (const name of extractDollarNames(source)) allPlaceholders.add(name)
    foreignPlaceholders.push(...extractForeignPlaceholders(source))
  }

  const missingParams = [...allPlaceholders].filter((name) => !keySet.has(name))
  if (missingParams.length > 0 || foreignPlaceholders.length > 0) {
    throw new PlaceholderMismatchError({
      sql: baseSql,
      missingParams,
      foreignPlaceholders,
    })
  }
}

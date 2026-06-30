/**
 * Pattern matching a safe SQL identifier (table or column name): an ASCII
 * letter or underscore followed by letters, digits, or underscores. Used to
 * gate string interpolation into DDL where placeholder binding is not
 * available (e.g. `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`).
 *
 * Shared between DDL emission and runtime migrations so the rule for what
 * counts as a valid identifier lives in one place.
 */
export const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/

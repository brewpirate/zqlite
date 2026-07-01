import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  ColumnTypeMismatchError,
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
  defineQuery,
  DuplicateMigrationVersionError,
  defineDynamicQuery,
  defineWrite,
  execWrite,
  InvalidColumnDefinitionError,
  InvalidIdentifierError,
  MissingTableError,
  migrate,
  migrateAddColumn,
  migrateDropColumn,
  migrateRenameColumn,
  NestedTypeError,
  QueryValidationError,
  TransactionRollbackError,
  zodToSqliteDDL,
  zJsonArray,
  zJsonSchema,
  zSqliteBool,
  type SqliteAdapter,
  type WriteHandle,
} from '../src/index'
import { VALID_IDENTIFIER } from '../src/identifiers'
import { serializeRow, serializeValue } from '../src/serialize'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
})

/**
 * Compile-time fixtures — never executed. Their job is to fail `tsc` if the
 * `DefineQueryOptions<P>` type bound regresses to accept scalar params
 * schemas. Each `// @ts-expect-error` flips into a build error if the
 * suppressed line ever stops erroring.
 */
function _typeBoundChecksNeverCalled(): void {
  // @ts-expect-error — params must be ZodObject<ZodRawShape>, not a scalar string schema
  defineQuery({ db, params: z.string(), result: z.object({}), sql: 'SELECT 1' })
  // @ts-expect-error — params must be ZodObject<ZodRawShape>, not z.number()
  defineQuery({ db, params: z.number(), result: z.object({}), sql: 'SELECT 1' })
  defineQuery({
    db,
    // @ts-expect-error — params must be ZodObject, not a discriminated union of objects
    params: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    result: z.object({}),
    sql: 'SELECT 1',
  })
}

/**
 * Reads back the column names of a table via `PRAGMA table_info`. Replaces the
 * repeated `db.query('PRAGMA table_info(...)').all().map((column) => column.name)`
 * projection used across the migrateAddColumn / migrateDropColumn /
 * migrateRenameColumn assertions. Couples those copies on the single way this
 * suite introspects a table's columns.
 *
 * @param table - The table whose column names to read.
 */
function listColumnNames(table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((columnInfo) => columnInfo.name)
}

// ---------------------------------------------------------------------------
// VALID_IDENTIFIER
// ---------------------------------------------------------------------------

describe('VALID_IDENTIFIER', () => {
  test('accepts ASCII letters, digits, and underscores starting with a letter or underscore', () => {
    expect(VALID_IDENTIFIER.test('items')).toBe(true)
    expect(VALID_IDENTIFIER.test('Items_2')).toBe(true)
    expect(VALID_IDENTIFIER.test('_private')).toBe(true)
    expect(VALID_IDENTIFIER.test('a')).toBe(true)
  })

  test('rejects identifiers starting with a digit', () => {
    expect(VALID_IDENTIFIER.test('1items')).toBe(false)
  })

  test('rejects identifiers containing dashes, spaces, or punctuation', () => {
    expect(VALID_IDENTIFIER.test('bad-name')).toBe(false)
    expect(VALID_IDENTIFIER.test('bad name')).toBe(false)
    expect(VALID_IDENTIFIER.test('bad-col!')).toBe(false)
    expect(VALID_IDENTIFIER.test('items;DROP')).toBe(false)
  })

  test('rejects the empty string', () => {
    expect(VALID_IDENTIFIER.test('')).toBe(false)
  })

  test('is anchored — rejects strings with a valid prefix but invalid trailing characters', () => {
    expect(VALID_IDENTIFIER.test('items\nDROP')).toBe(false)
    expect(VALID_IDENTIFIER.test('items DROP')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serializeValue
// ---------------------------------------------------------------------------

describe('serializeValue', () => {
  test('passes strings through unchanged', () => {
    expect(serializeValue('hello')).toBe('hello')
  })

  test('passes numbers through unchanged', () => {
    expect(serializeValue(42)).toBe(42)
    expect(serializeValue(3.14)).toBe(3.14)
  })

  test('converts true to 1', () => {
    expect(serializeValue(true)).toBe(1)
  })

  test('converts false to 0', () => {
    expect(serializeValue(false)).toBe(0)
  })

  test('converts Date to ISO string', () => {
    const date = new Date('2026-01-15T12:00:00.000Z')
    expect(serializeValue(date)).toBe('2026-01-15T12:00:00.000Z')
  })

  test('converts null to null', () => {
    expect(serializeValue(null)).toBeNull()
  })

  test('converts undefined to null', () => {
    expect(serializeValue(undefined)).toBeNull()
  })

  test('JSON-stringifies plain objects', () => {
    expect(serializeValue({ a: 1 })).toBe('{"a":1}')
  })

  test('JSON-stringifies arrays', () => {
    expect(serializeValue([1, 2, 3])).toBe('[1,2,3]')
  })
})

// ---------------------------------------------------------------------------
// serializeRow
// ---------------------------------------------------------------------------

describe('serializeRow', () => {
  test('serializes each value in the record', () => {
    const result = serializeRow({
      name: 'alice',
      active: true,
      score: 9.5,
      data: null,
    })
    expect(result).toEqual({ name: 'alice', active: 1, score: 9.5, data: null })
  })
})

// ---------------------------------------------------------------------------
// zodToSqliteDDL
// ---------------------------------------------------------------------------

/**
 * Generates DDL for a schema and asserts the column emits its DEFAULT clause
 * without a NOT NULL constraint — the shared shape of the
 * `.default().nullable()` / `.nullable().default()` / `.optional().default()`
 * wrapper-chain tests. Replaces the repeated `zodToSqliteDDL` + `toContain` +
 * `not.toMatch(/… NOT NULL/)` block. The schema, the expected DEFAULT fragment,
 * and the forbidden NOT NULL fragment vary per test, so they are passed in.
 *
 * @param opts.schema - The Zod object schema to generate DDL for.
 * @param opts.defaultClause - The exact DEFAULT fragment the DDL must contain (e.g. 'count INTEGER DEFAULT 0').
 * @param opts.notNullClause - The 'col TYPE NOT NULL' fragment the DDL must NOT contain.
 */
function expectDefaultWithoutNotNull(opts: {
  schema: z.ZodObject
  defaultClause: string
  notNullClause: string
}): void {
  const { schema, defaultClause, notNullClause } = opts
  const ddl = zodToSqliteDDL({ table: 'items', schema })
  expect(ddl).toContain(defaultClause)
  expect(ddl).not.toMatch(new RegExp(notNullClause))
}

describe('zodToSqliteDDL', () => {
  test('emits TEXT NOT NULL for z.string()', () => {
    const schema = z.object({ name: z.string() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('name TEXT NOT NULL')
  })

  test('emits INTEGER NOT NULL for z.number().int()', () => {
    const schema = z.object({ count: z.number().int() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('count INTEGER NOT NULL')
  })

  test('emits REAL NOT NULL for z.number().positive() (constrained but not int)', () => {
    // Regression: previous safeParse(0.5) heuristic flipped this to INTEGER
    // because .positive() rejects 0.5 not because it's fractional but because
    // it's <= 0. Constrained reals must stay REAL.
    const schema = z.object({ score: z.number().positive() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('score REAL NOT NULL')
  })

  test('emits REAL NOT NULL for z.number().min(1) (constrained but not int)', () => {
    const schema = z.object({ score: z.number().min(1) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('score REAL NOT NULL')
  })

  test('emits REAL NOT NULL for z.number() without int()', () => {
    const schema = z.object({ score: z.number() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('score REAL NOT NULL')
  })

  test('emits INTEGER NOT NULL for z.boolean()', () => {
    const schema = z.object({ active: z.boolean() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('active INTEGER NOT NULL')
  })

  test('emits TEXT NOT NULL for z.date()', () => {
    const schema = z.object({ created_at: z.date() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('created_at TEXT NOT NULL')
  })

  test('emits TEXT NOT NULL for z.iso.datetime()', () => {
    const schema = z.object({ created_at: z.iso.datetime() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('created_at TEXT NOT NULL')
  })

  test('emits TEXT for nullable z.iso.datetime()', () => {
    const schema = z.object({ ended_at: z.iso.datetime().nullable() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('ended_at TEXT')
    expect(ddl).not.toContain('NOT NULL')
  })

  test('emits TEXT NOT NULL for z.iso.date() and z.iso.time()', () => {
    const schema = z.object({
      day: z.iso.date(),
      clock: z.iso.time(),
    })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('day TEXT NOT NULL')
    expect(ddl).toContain('clock TEXT NOT NULL')
  })

  test('omits NOT NULL for optional fields', () => {
    const schema = z.object({ nickname: z.string().optional() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('nickname TEXT')
    expect(ddl).not.toContain('NOT NULL')
  })

  test('omits NOT NULL for nullable fields', () => {
    const schema = z.object({ bio: z.string().nullable() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('bio TEXT')
    expect(ddl).not.toContain('NOT NULL')
  })

  test('emits CHECK constraint for z.enum()', () => {
    const schema = z.object({ role: z.enum(['admin', 'user']) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain("CHECK(role IN ('admin', 'user'))")
  })

  test('emits CHECK constraint for z.literal()', () => {
    const schema = z.object({ kind: z.literal('widget') })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain("CHECK(kind = 'widget')")
  })

  test('emits DEFAULT for numeric .default()', () => {
    const schema = z.object({ count: z.number().int().default(0) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('count INTEGER NOT NULL DEFAULT 0')
  })

  test('emits DEFAULT for string .default(), with single-quote escaping', () => {
    const schema = z.object({ status: z.string().default("it's-on") })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain("status TEXT NOT NULL DEFAULT 'it''s-on'")
  })

  test('emits DEFAULT for boolean .default()', () => {
    const schema = z.object({ active: z.boolean().default(true) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('active INTEGER NOT NULL DEFAULT 1')
  })

  test('omits DEFAULT for JSON columns (no ZodDefault wrapper)', () => {
    // zJsonArray() is a ZodPipe rather than a ZodDefault, so resolveDefaultClause
    // returns '' and the column has no DEFAULT — runtime defaulting still
    // happens at the Zod parse layer when inserting an empty string.
    const schema = z.object({
      tags: zJsonArray<string>([]),
    })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('tags TEXT NOT NULL')
    expect(ddl).not.toContain('DEFAULT')
  })

  test('throws UnsupportedDefaultError for Date default', () => {
    const schema = z.object({
      created_at: z.date().default(() => new Date('2020-01-01')),
    })
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      /Unsupported default for column "created_at"/,
    )
  })

  test('throws UnsupportedDefaultError for object default', () => {
    // Cast the default through unknown — Zod accepts a callable that returns
    // any shape; the SQL DDL layer is the gatekeeper for SQL-literal viability.
    const schema = z.object({
      meta: z.string().default((() => ({ k: 1 })) as unknown as () => string),
    })
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      /Unsupported default/,
    )
  })

  test('throws UnsupportedDefaultError for NaN numeric default', () => {
    const schema = z.object({ ratio: z.number().default(Number.NaN) })
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      /non-finite number/,
    )
  })

  test('throws UnsupportedDefaultError for Infinity numeric default', () => {
    const schema = z.object({
      ratio: z.number().default(Number.POSITIVE_INFINITY),
    })
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      /non-finite number/,
    )
  })

  test('emits DEFAULT alongside CHECK constraint for z.enum().default()', () => {
    const schema = z.object({
      role: z.enum(['admin', 'user']).default('user'),
    })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain(
      "role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user'))",
    )
  })

  test('emits DEFAULT without NOT NULL for .default(x).nullable() (ZodNullable outermost)', () => {
    expectDefaultWithoutNotNull({
      schema: z.object({ count: z.number().int().default(0).nullable() }),
      defaultClause: 'count INTEGER DEFAULT 0',
      notNullClause: 'count INTEGER NOT NULL',
    })
  })

  test('emits DEFAULT without NOT NULL for .nullable().default(x) (ZodDefault outermost)', () => {
    // Regression: isNullable previously only inspected the outermost wrapper,
    // missing the ZodNullable buried under ZodDefault → wrong NOT NULL DEFAULT x.
    expectDefaultWithoutNotNull({
      schema: z.object({ count: z.number().int().nullable().default(0) }),
      defaultClause: 'count INTEGER DEFAULT 0',
      notNullClause: 'count INTEGER NOT NULL',
    })
  })

  test('emits DEFAULT for .optional().default(x) wrapper chain', () => {
    // Exercises the while-loop in resolveDefaultClause that peels Optional
    // before locating ZodDefault.
    expectDefaultWithoutNotNull({
      schema: z.object({ name: z.string().optional().default('anon') }),
      defaultClause: "name TEXT DEFAULT 'anon'",
      notNullClause: 'name TEXT NOT NULL',
    })
  })

  test("escapes embedded single quotes in z.enum() values per SQLite's doubled-quote rule", () => {
    const schema = z.object({ phrase: z.enum(["it's", 'ok']) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain("CHECK(phrase IN ('it''s', 'ok'))")
    // And the result is valid SQL — SQLite accepts the table.
    expect(() => db.run(ddl)).not.toThrow()
  })

  test('escapes embedded single quotes in z.literal() string values', () => {
    const schema = z.object({ kind: z.literal("it's") })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain("CHECK(kind = 'it''s')")
    expect(() => db.run(ddl)).not.toThrow()
  })

  test('emits TEXT for zJsonSchema columns', () => {
    const schema = z.object({
      metadata: zJsonSchema(z.object({ value: z.number() })),
    })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('metadata TEXT')
  })

  test('emits inline PRIMARY KEY for single-column key', () => {
    const schema = z.object({ id: z.string(), name: z.string() })
    const ddl = zodToSqliteDDL({ table: 'items', schema, primaryKey: ['id'] })
    expect(ddl).toContain('id TEXT PRIMARY KEY')
    expect(ddl).not.toContain('PRIMARY KEY (')
  })

  test('emits table-level PRIMARY KEY for composite key', () => {
    const schema = z.object({ a: z.string(), b: z.string() })
    const ddl = zodToSqliteDDL({
      table: 'items',
      schema,
      primaryKey: ['a', 'b'],
    })
    expect(ddl).toContain('PRIMARY KEY (a, b)')
  })

  test('throws on invalid table name', () => {
    const schema = z.object({ id: z.string() })
    expect(() => zodToSqliteDDL({ table: 'bad-name', schema })).toThrow(
      'Invalid table name',
    )
  })

  test('throws NestedTypeError on z.object() column without zJsonSchema', () => {
    const schema = z.object({ nested: z.object({ x: z.number() }) })
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      NestedTypeError,
    )
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      'Use zJsonSchema()',
    )
  })

  test('throws NestedTypeError on bare z.array() column', () => {
    const schema = z.object({ tags: z.array(z.string()) })
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow(
      NestedTypeError,
    )
    expect(() => zodToSqliteDDL({ table: 'items', schema })).toThrow('"tags"')
  })

  test('integer column affinity is correct end-to-end via PRAGMA', () => {
    const schema = z.object({
      id: z.string(),
      count: z.number().int(),
      score: z.number(),
    })
    db.run(zodToSqliteDDL({ table: 'things', schema, primaryKey: ['id'] }))
    const columns = db
      .query<{ name: string; type: string }, []>('PRAGMA table_info(things)')
      .all()
    const columnTypes = Object.fromEntries(
      columns.map((columnInfo) => [columnInfo.name, columnInfo.type]),
    )
    expect(columnTypes.count).toBe('INTEGER')
    expect(columnTypes.score).toBe('REAL')
  })

  test('generates valid DDL that SQLite accepts', () => {
    const schema = z.object({
      id: z.string(),
      count: z.number().int(),
      active: z.boolean(),
      created_at: z.date(),
      label: z.string().nullable(),
    })
    const ddl = zodToSqliteDDL({ table: 'things', schema, primaryKey: ['id'] })
    expect(() => db.run(ddl)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// defineQuery
// ---------------------------------------------------------------------------

const NoteSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  done: z.boolean(),
  created_at: z.date(),
})

function seedNotes() {
  db.run(`CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    done INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`)
  db.run(
    `INSERT INTO notes VALUES (1, 'Buy milk', 0, '2026-01-01T00:00:00.000Z')`,
  )
  db.run(
    `INSERT INTO notes VALUES (2, 'Write tests', 1, '2026-01-02T00:00:00.000Z')`,
  )
}

/**
 * Builds the canonical "find a note by id" query handle used across the
 * `defineQuery — .one()` and validation tests. Replaces five identical inline
 * `defineQuery({ db, params: { id }, result: NoteSchema, sql })` blocks. The
 * coupling is correct: every caller queries the same `notes` table shape via
 * {@link NoteSchema}, so a change to that table or its lookup SQL must change
 * all of them together. Closes over the module-level `db`, which `beforeEach`
 * reassigns before each test.
 */
function defineFindNoteById() {
  return defineQuery({
    db,
    params: z.object({ id: z.number().int() }),
    result: NoteSchema,
    sql: 'SELECT * FROM notes WHERE id = $id',
  })
}

/**
 * Builds the full-row insert query handle the `defineQuery — .run()` tests use
 * to exercise param serialization (boolean → 0/1, Date → ISO). Replaces two
 * identical inline `defineQuery` insert blocks. The params shape mirrors every
 * column of the `notes` table {@link seedNotes} creates, so a column change
 * must update this factory and the seed together.
 */
function defineInsertNote() {
  return defineQuery({
    db,
    params: z.object({
      id: z.number().int(),
      title: z.string(),
      done: z.boolean(),
      created_at: z.date(),
    }),
    result: z.object({}),
    sql: 'INSERT INTO notes VALUES ($id, $title, $done, $created_at)',
  })
}

describe('defineQuery — .one()', () => {
  test('returns the matching row', () => {
    seedNotes()
    const findNote = defineFindNoteById()
    const note = findNote.one({ id: 1 })
    expect(note?.title).toBe('Buy milk')
  })

  test('returns null when no row matches', () => {
    seedNotes()
    const findNote = defineFindNoteById()
    expect(findNote.one({ id: 99 })).toBeNull()
  })

  test('coerces 0/1 INTEGER to boolean', () => {
    seedNotes()
    const findNote = defineFindNoteById()
    expect(findNote.one({ id: 1 })?.done).toBe(false)
    expect(findNote.one({ id: 2 })?.done).toBe(true)
  })

  test('coerces ISO string to Date', () => {
    seedNotes()
    const findNote = defineFindNoteById()
    const note = findNote.one({ id: 1 })
    expect(note?.created_at).toBeInstanceOf(Date)
    expect(note?.created_at.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('defineQuery — .all()', () => {
  test('returns all matching rows', () => {
    seedNotes()
    const listNotes = defineQuery({
      db,
      params: z.object({}),
      result: NoteSchema,
      sql: 'SELECT * FROM notes ORDER BY id',
    })
    const notes = listNotes.all({})
    expect(notes).toHaveLength(2)
    expect(notes[0]?.title).toBe('Buy milk')
    expect(notes[1]?.title).toBe('Write tests')
  })

  test('returns empty array when nothing matches', () => {
    seedNotes()
    const listDone = defineQuery({
      db,
      params: z.object({ done: z.number().int() }),
      result: NoteSchema,
      sql: 'SELECT * FROM notes WHERE done = $done AND id > 99',
    })
    expect(listDone.all({ done: 1 })).toHaveLength(0)
  })
})

/**
 * Result schema for the `things` table used by the validation tests. The
 * `status` column is a two-value enum so a stored `'deleted'` row fails
 * validation on read — that is what drives the {@link QueryValidationError}
 * assertions. Hoisted from three identical inline copies; if the enum or the
 * table shape changes, all the validation tests must change together.
 */
const StatusSchema = z.object({
  id: z.number().int(),
  status: z.enum(['active', 'inactive']),
})

/**
 * Creates the empty `things` table that the validation tests seed differently
 * (one bad row, or two good rows plus a bad one). Replaces the repeated
 * `CREATE TABLE things (...)` statement; the row shape it declares is the SQL
 * mirror of {@link StatusSchema}.
 */
function createThingsTable(): void {
  db.run('CREATE TABLE things (id INTEGER PRIMARY KEY, status TEXT NOT NULL)')
}

/**
 * Builds the "find a thing by id" query handle the validation tests use to
 * trigger a single-row {@link QueryValidationError}. Replaces two identical
 * inline `defineQuery` blocks; couples on the shared `things` table shape via
 * {@link StatusSchema}.
 */
function defineFindThingById() {
  return defineQuery({
    db,
    params: z.object({ id: z.number().int() }),
    result: StatusSchema,
    sql: 'SELECT * FROM things WHERE id = $id',
  })
}

describe('defineQuery — validation', () => {
  test('throws when params fail schema validation', () => {
    seedNotes()
    const findNote = defineFindNoteById()
    // @ts-expect-error — intentionally testing invalid input
    expect(() => findNote.one({ id: 'not-a-number' })).toThrow()
  })

  test('throws when result row fails schema validation', () => {
    createThingsTable()
    db.run("INSERT INTO things VALUES (1, 'deleted')")

    const findThing = defineFindThingById()
    expect(() => findThing.one({ id: 1 })).toThrow(QueryValidationError)
  })

  test('.all() validation error reports the offending row index', () => {
    // Two rows are valid; the third has a status the schema rejects. The
    // thrown QueryValidationError should carry rowIndex=2 so a user
    // debugging the failure can locate the bad row immediately.
    createThingsTable()
    db.run("INSERT INTO things VALUES (1, 'active')")
    db.run("INSERT INTO things VALUES (2, 'inactive')")
    db.run("INSERT INTO things VALUES (3, 'deleted')")

    const listThings = defineQuery({
      db,
      params: z.object({}),
      result: StatusSchema,
      sql: 'SELECT * FROM things ORDER BY id',
    })
    let caught: unknown
    try {
      listThings.all({})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(QueryValidationError)
    expect((caught as QueryValidationError).rowIndex).toBe(2)
    expect((caught as Error).message).toContain('(row 2)')
  })

  test('.one() validation error has no rowIndex', () => {
    createThingsTable()
    db.run("INSERT INTO things VALUES (1, 'deleted')")

    const findThing = defineFindThingById()
    let caught: unknown
    try {
      findThing.one({ id: 1 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(QueryValidationError)
    expect((caught as QueryValidationError).rowIndex).toBeUndefined()
  })
})

describe('defineQuery — .run()', () => {
  test('inserts a row and it is retrievable', () => {
    seedNotes()
    const insertNote = defineInsertNote()
    insertNote.run({
      id: 3,
      title: 'Third note',
      done: false,
      created_at: new Date('2026-01-03T00:00:00.000Z'),
    })
    const row = db.query('SELECT * FROM notes WHERE id = 3').get() as {
      title: string
    }
    expect(row.title).toBe('Third note')
  })

  test('serializes boolean param to 0/1', () => {
    seedNotes()
    const insertNote = defineInsertNote()
    insertNote.run({
      id: 4,
      title: 'Done note',
      done: true,
      created_at: new Date(),
    })
    const row = db.query('SELECT done FROM notes WHERE id = 4').get() as {
      done: number
    }
    expect(row.done).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// zJsonSchema / zJsonArray
// ---------------------------------------------------------------------------

/**
 * Builds the "select an item by id" query handle the JSON-column tests share.
 * Each test declares its own `items` row schema (object meta, defaulted meta,
 * string-array tags), so the result schema is the one part that varies and is
 * passed in; the params shape and SQL are identical across all five inline
 * copies this replaces. Couples those copies on the single `items` lookup SQL.
 *
 * @param resultRowSchema - The per-test row schema validated for each result row.
 */
function defineSelectItemById<RowSchema extends z.ZodObject>(
  resultRowSchema: RowSchema,
) {
  return defineQuery({
    db,
    params: z.object({ id: z.number().int() }),
    result: resultRowSchema,
    sql: 'SELECT * FROM items WHERE id = $id',
  })
}

describe('zJsonSchema', () => {
  test('round-trips a JSON object column through defineQuery', () => {
    const MetaSchema = z.object({
      version: z.number(),
      tags: z.array(z.string()),
    })
    const RowSchema = z.object({
      id: z.number().int(),
      meta: zJsonSchema(MetaSchema),
    })
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, meta TEXT NOT NULL)')

    const insert = defineQuery({
      db,
      params: createInsertSchema(RowSchema),
      result: RowSchema,
      sql: 'INSERT INTO items VALUES ($id, $meta)',
    })
    const select = defineSelectItemById(RowSchema)

    insert.run({ id: 1, meta: { version: 2, tags: ['a', 'b'] } })
    const row = select.one({ id: 1 })
    expect(row?.meta).toEqual({ version: 2, tags: ['a', 'b'] })
  })

  test('throws when stored JSON does not match inner schema', () => {
    const RowSchema = z.object({
      id: z.number().int(),
      meta: zJsonSchema(z.object({ version: z.number() })),
    })
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, meta TEXT NOT NULL)')
    db.run(`INSERT INTO items VALUES (1, '{"version":"not-a-number"}')`)

    const select = defineSelectItemById(RowSchema)
    expect(() => select.one({ id: 1 })).toThrow(
      'Query result validation failed',
    )
  })

  test('returns defaultValue when stored value is empty string', () => {
    const defaultMeta = { version: 0 }
    const RowSchema = z.object({
      id: z.number().int(),
      meta: zJsonSchema(z.object({ version: z.number() }), defaultMeta),
    })
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, meta TEXT NOT NULL)')
    db.run(`INSERT INTO items VALUES (1, '')`)

    const select = defineSelectItemById(RowSchema)
    expect(select.one({ id: 1 })?.meta).toEqual(defaultMeta)
  })
})

describe('zJsonArray', () => {
  test('round-trips a JSON array column through defineQuery', () => {
    const RowSchema = z.object({
      id: z.number().int(),
      tags: zJsonArray<string>(),
    })
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, tags TEXT NOT NULL)')

    const insert = defineQuery({
      db,
      params: createInsertSchema(RowSchema),
      result: RowSchema,
      sql: 'INSERT INTO items VALUES ($id, $tags)',
    })
    const select = defineSelectItemById(RowSchema)

    insert.run({ id: 1, tags: ['x', 'y', 'z'] })
    const row = select.one({ id: 1 })
    expect(row?.tags).toEqual(['x', 'y', 'z'])
  })

  test('returns default empty array for empty string stored value', () => {
    const RowSchema = z.object({
      id: z.number().int(),
      tags: zJsonArray<string>(),
    })
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, tags TEXT NOT NULL)')
    db.run(`INSERT INTO items VALUES (1, '')`)

    const select = defineSelectItemById(RowSchema)
    expect(select.one({ id: 1 })?.tags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// createSelectSchema / createInsertSchema / createUpdateSchema
// ---------------------------------------------------------------------------

const BaseSchema = z.object({
  id: z.string(),
  label: z.string(),
  score: z.number().nullable(),
  active: z.boolean().default(true),
})

describe('zSqliteBool', () => {
  test('emits INTEGER NOT NULL CHECK(col IN (0, 1)) without a default', () => {
    const schema = z.object({ active: zSqliteBool() })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain('active INTEGER NOT NULL CHECK(active IN (0, 1))')
    expect(ddl).not.toContain('DEFAULT')
    // SQLite accepts the table — the CHECK clause is well-formed.
    expect(() => db.run(ddl)).not.toThrow()
  })

  test('emits DEFAULT 0 alongside the CHECK constraint', () => {
    const schema = z.object({ active: zSqliteBool(0) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain(
      'active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1))',
    )
    expect(() => db.run(ddl)).not.toThrow()
  })

  test('emits DEFAULT 1 alongside the CHECK constraint', () => {
    const schema = z.object({ active: zSqliteBool(1) })
    const ddl = zodToSqliteDDL({ table: 'items', schema })
    expect(ddl).toContain(
      'active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))',
    )
    expect(() => db.run(ddl)).not.toThrow()
  })

  test('parses 0 and 1; rejects 2, true, string, null, undefined (no default)', () => {
    const bool = zSqliteBool()
    expect(bool.safeParse(0).success).toBe(true)
    expect(bool.safeParse(1).success).toBe(true)
    expect(bool.safeParse(2).success).toBe(false)
    expect(bool.safeParse(true).success).toBe(false)
    expect(bool.safeParse('1').success).toBe(false)
    expect(bool.safeParse(null).success).toBe(false)
    expect(bool.safeParse(undefined).success).toBe(false)
  })

  test('undefined input resolves to the configured default', () => {
    expect(zSqliteBool(0).parse(undefined)).toBe(0)
    expect(zSqliteBool(1).parse(undefined)).toBe(1)
    // Explicit 0 or 1 still wins over the default.
    expect(zSqliteBool(1).parse(0)).toBe(0)
    expect(zSqliteBool(0).parse(1)).toBe(1)
    // Invalid input is still rejected even with a default available.
    expect(zSqliteBool(0).safeParse(2).success).toBe(false)
  })

  test('CHECK constraint is enforced by SQLite at INSERT time', () => {
    const schema = z.object({ id: z.string(), active: zSqliteBool(0) })
    const ddl = zodToSqliteDDL({
      table: 'items',
      schema,
      primaryKey: ['id'],
    })
    db.run(ddl)
    expect(() =>
      db.prepare('INSERT INTO items (id, active) VALUES (?, ?)').run('a', 2),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      db.prepare('INSERT INTO items (id, active) VALUES (?, ?)').run('b', 1),
    ).not.toThrow()
  })
})

// Compile-time fixture: ensures `zSqliteBool()` infers to `0 | 1`, not
// `number`. If a future change widens the inferred type, this stops type-
// checking at the assignment.
function _zSqliteBoolTypeCheckNeverCalled(): void {
  const x = zSqliteBool().parse(0)
  const _a: 0 | 1 = x
  const y = zSqliteBool(1).parse(undefined)
  const _b: 0 | 1 = y
  // @ts-expect-error — must not widen to `number`
  const _c: 2 = x
  // Silence unused-var warnings under strict TS.
  void _a
  void _b
  void _c
}

describe('createSelectSchema', () => {
  test('preserves the base shape unchanged', () => {
    const schema = createSelectSchema(BaseSchema)
    expect(
      schema.parse({ id: 'a', label: 'foo', score: null, active: true }),
    ).toEqual({
      id: 'a',
      label: 'foo',
      score: null,
      active: true,
    })
  })

  test('applies a per-field refinement', () => {
    const schema = createSelectSchema(BaseSchema, {
      label: (field) => field.transform((value) => value.toUpperCase()),
    })
    const parsed = schema.parse({
      id: 'a',
      label: 'foo',
      score: null,
      active: true,
    })
    expect(parsed.label).toBe('FOO')
  })
})

describe('createInsertSchema', () => {
  test('makes nullable fields optional (can be omitted)', () => {
    const schema = createInsertSchema(BaseSchema)
    const result = schema.parse({ id: 'a', label: 'foo', active: true })
    expect(result.score).toBeUndefined()
  })

  test('makes defaulted fields optional (can be omitted)', () => {
    const schema = createInsertSchema(BaseSchema)
    const result = schema.parse({ id: 'a', label: 'foo', score: null })
    expect(result.active).toBeUndefined()
  })

  test('still requires non-nullable non-defaulted fields', () => {
    const schema = createInsertSchema(BaseSchema)
    expect(() => schema.parse({ id: 'a', score: null })).toThrow()
  })

  test('applies a per-field refinement', () => {
    const schema = createInsertSchema(BaseSchema, {
      label: z.string().min(1),
    })
    expect(() => schema.parse({ id: 'a', label: '', score: null })).toThrow()
    expect(() =>
      schema.parse({ id: 'a', label: 'x', score: null }),
    ).not.toThrow()
  })

  test('replaces a zJsonSchema field with its inner schema for write-side validation', () => {
    // Confirms `resolveJsonColumn` swaps the JSON pipe for the inner object
    // schema. Without this the insert schema would expect a JSON string and
    // accept any string at validation time — including invalid payloads.
    const InnerSchema = z.object({
      version: z.number(),
      tags: z.array(z.string()),
    })
    const RowSchema = z.object({
      id: z.string(),
      meta: zJsonSchema(InnerSchema),
    })
    const schema = createInsertSchema(RowSchema)
    // Valid object passes
    expect(() =>
      schema.parse({ id: 'a', meta: { version: 1, tags: ['x'] } }),
    ).not.toThrow()
    // Invalid object structure fails — proves the inner schema is enforced,
    // not just "any string".
    expect(() =>
      schema.parse({ id: 'a', meta: { version: 'wrong', tags: ['x'] } }),
    ).toThrow()
    // Pre-stringified JSON is now rejected (the type expects an object).
    expect(() =>
      schema.parse({ id: 'a', meta: '{"version":1,"tags":[]}' }),
    ).toThrow()
  })
})

describe('createUpdateSchema', () => {
  test('makes every field optional', () => {
    const schema = createUpdateSchema(BaseSchema)
    expect(() => schema.parse({})).not.toThrow()
  })

  test('still validates provided fields', () => {
    const schema = createUpdateSchema(BaseSchema)
    expect(() => schema.parse({ score: 'not-a-number' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

/**
 * Reads back the names of the `a` / `b` tables the migrate tests create (or
 * expect to have been rolled back). Replaces the repeated
 * `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')`
 * query plus its `.map((row) => row.name)` projection. Couples those copies on
 * the fixed set of table names the migrate suite uses.
 */
function listTableNamesAOrB(): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')",
    )
    .all()
    .map((tableRow) => tableRow.name)
}

describe('migrate', () => {
  test('creates schema_version table on first run', () => {
    migrate(db, [])
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toContain('schema_version')
  })

  test('applies migrations in version order', () => {
    migrate(db, [
      { version: 1, up: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
      { version: 2, up: 'CREATE TABLE b (id INTEGER PRIMARY KEY)' },
    ])
    const tables = listTableNamesAOrB()
    expect(tables).toContain('a')
    expect(tables).toContain('b')
  })

  test('skips already-applied migrations on subsequent calls', () => {
    const migrations = [
      { version: 1, up: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
    ]
    migrate(db, migrations)
    expect(() => migrate(db, migrations)).not.toThrow()
  })

  test('records applied version in schema_version', () => {
    migrate(db, [{ version: 1, up: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' }])
    const row = db
      .query<{ version: number }, []>(
        'SELECT MAX(version) as version FROM schema_version',
      )
      .get()
    expect(row?.version).toBe(1)
  })

  test('applies migrations in version order regardless of array order', () => {
    migrate(db, [
      { version: 2, up: 'CREATE TABLE b (id INTEGER PRIMARY KEY)' },
      { version: 1, up: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
    ])
    const tables = listTableNamesAOrB()
    expect(tables).toContain('a')
    expect(tables).toContain('b')
  })

  test('throws DuplicateMigrationVersionError on duplicate versions', () => {
    let caught: unknown
    try {
      migrate(db, [
        { version: 1, up: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' },
        { version: 1, up: 'CREATE TABLE b (id INTEGER PRIMARY KEY)' },
      ])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DuplicateMigrationVersionError)
    expect((caught as DuplicateMigrationVersionError).version).toBe(1)
  })

  test('rolls back if a migration fails, leaving version unchanged', () => {
    migrate(db, [{ version: 1, up: 'CREATE TABLE a (id INTEGER PRIMARY KEY)' }])
    expect(() =>
      migrate(db, [{ version: 2, up: 'NOT VALID SQL !!!' }]),
    ).toThrow()
    const row = db
      .query<{ version: number }, []>(
        'SELECT MAX(version) as version FROM schema_version',
      )
      .get()
    expect(row?.version).toBe(1)
  })

  test('array up form applies every statement in order', () => {
    migrate(db, [
      {
        version: 1,
        up: [
          'CREATE TABLE a (id INTEGER PRIMARY KEY)',
          'CREATE TABLE b (id INTEGER PRIMARY KEY)',
          'CREATE INDEX idx_a ON a(id)',
        ],
      },
    ])
    const tables = listTableNamesAOrB()
    expect(tables).toContain('a')
    expect(tables).toContain('b')
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_a'",
      )
      .all()
      .map((row) => row.name)
    expect(indexes).toContain('idx_a')
  })

  test('array up form rolls back on a mid-sequence failure', () => {
    expect(() =>
      migrate(db, [
        {
          version: 1,
          up: [
            'CREATE TABLE a (id INTEGER PRIMARY KEY)',
            'NOT VALID SQL !!!',
            'CREATE TABLE b (id INTEGER PRIMARY KEY)',
          ],
        },
      ]),
    ).toThrow()
    const tables = listTableNamesAOrB()
    expect(tables).toHaveLength(0)
    const row = db
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) as version FROM schema_version',
      )
      .get()
    expect(row?.version).toBeNull()
  })

  test('function up form receives the live db and writes commit via the surrounding transaction', () => {
    migrate(db, [
      {
        version: 1,
        up: (database) => {
          database
            .prepare(
              'CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
            )
            .run()
          database.prepare('INSERT INTO a VALUES (1, 100)').run()
          database.prepare('INSERT INTO a VALUES (2, 200)').run()
        },
      },
    ])
    const rows = db
      .query<{ id: number; n: number }, []>('SELECT id, n FROM a ORDER BY id')
      .all()
    expect(rows).toEqual([
      { id: 1, n: 100 },
      { id: 2, n: 200 },
    ])
    const versionRow = db
      .query<{ version: number }, []>(
        'SELECT MAX(version) as version FROM schema_version',
      )
      .get()
    expect(versionRow?.version).toBe(1)
  })

  test('function up form throwing rolls back and schema_version stays unchanged', () => {
    expect(() =>
      migrate(db, [
        {
          version: 1,
          up: (database) => {
            database.prepare('CREATE TABLE a (id INTEGER PRIMARY KEY)').run()
            throw new Error('oops')
          },
        },
      ]),
    ).toThrow('oops')
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='a'",
      )
      .all()
    expect(tables).toHaveLength(0)
    const row = db
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) as version FROM schema_version',
      )
      .get()
    expect(row?.version).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// migrateAddColumn
// ---------------------------------------------------------------------------

/**
 * Runs a migration thunk expected to throw {@link MissingTableError} and asserts
 * the error's instance, `table`, and `operation` fields. Replaces the identical
 * try/catch + instanceof + field-assertion block repeated across the add-, drop-,
 * and rename-column "missing table" tests. The operation label varies per
 * migration kind, so it is passed in; everything else is the shared knowledge
 * (the error must carry which table and which operation failed).
 *
 * Returns the caught error so a caller that also checks the message (the
 * add/drop tests) can assert on it without re-running the migration.
 *
 * @param opts.run - The migration call expected to throw.
 * @param opts.table - The table name the error must report.
 * @param opts.operation - The operation label the error must report (e.g. 'add column').
 */
function expectMissingTableError(opts: {
  run: () => void
  table: string
  operation: string
}): MissingTableError {
  const { run, table, operation } = opts
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(MissingTableError)
  const wrapped = caught as MissingTableError
  expect(wrapped.table).toBe(table)
  expect(wrapped.operation).toBe(operation)
  return wrapped
}

/**
 * Runs a migration thunk expected to throw {@link InvalidIdentifierError} and
 * asserts the error's instance and `kind`, plus `value` when the caller knows
 * the offending identifier. Replaces the identical try/catch + instanceof +
 * field-assertion block repeated across the add-, drop-, and rename-column
 * invalid-name tests. The rename tests assert only `kind`, so `value` is
 * optional; the add/drop tests pass it to keep their `value` assertion.
 *
 * @param opts.run - The migration call expected to throw.
 * @param opts.kind - The identifier kind the error must report ('table' or 'column').
 * @param opts.value - The offending identifier the error must report, when asserted.
 */
function expectInvalidIdentifierError(opts: {
  run: () => void
  kind: 'table' | 'column'
  value?: string
}): void {
  const { run, kind, value } = opts
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(InvalidIdentifierError)
  const wrapped = caught as InvalidIdentifierError
  expect(wrapped.kind).toBe(kind)
  if (value !== undefined) {
    expect(wrapped.value).toBe(value)
  }
}

describe('migrateAddColumn', () => {
  test('adds a column that does not exist', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    migrateAddColumn({
      db,
      table: 'items',
      column: 'label',
      definition: 'TEXT',
    })
    const columns = listColumnNames('items')
    expect(columns).toContain('label')
  })

  test('is a no-op if the column already exists', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
    expect(() =>
      migrateAddColumn({
        db,
        table: 'items',
        column: 'label',
        definition: 'TEXT',
      }),
    ).not.toThrow()
  })

  test('throws MissingTableError when the target table does not exist', () => {
    const wrapped = expectMissingTableError({
      run: () =>
        migrateAddColumn({
          db,
          table: 'nonexistent',
          column: 'label',
          definition: 'TEXT',
        }),
      table: 'nonexistent',
      operation: 'add column',
    })
    expect(wrapped.message).toContain('table "nonexistent" does not exist')
  })

  test('throws ColumnTypeMismatchError when the column exists with a different type', () => {
    db.run(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, label INTEGER NOT NULL)',
    )
    let caught: unknown
    try {
      migrateAddColumn({
        db,
        table: 'items',
        column: 'label',
        definition: 'TEXT NOT NULL',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ColumnTypeMismatchError)
    const wrapped = caught as ColumnTypeMismatchError
    expect(wrapped.table).toBe('items')
    expect(wrapped.column).toBe('label')
    expect(wrapped.actualType).toBe('INTEGER')
    expect(wrapped.expectedType).toBe('TEXT')
  })

  test('still no-ops when the column exists with the same type (constraints differ)', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
    expect(() =>
      migrateAddColumn({
        db,
        table: 'items',
        column: 'label',
        definition: "TEXT NOT NULL DEFAULT 'x'",
      }),
    ).not.toThrow()
  })

  test('matches column names case-insensitively (SQLite identifier semantics)', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
    // Caller passes `Label`; column was declared `label`. The membership
    // check must match — otherwise a second migration call would attempt to
    // ADD an existing column and SQLite would throw "duplicate column name".
    expect(() =>
      migrateAddColumn({
        db,
        table: 'items',
        column: 'Label',
        definition: 'TEXT',
      }),
    ).not.toThrow()
  })

  test('throws InvalidIdentifierError with kind=table on invalid table name', () => {
    expectInvalidIdentifierError({
      run: () =>
        migrateAddColumn({
          db,
          table: 'bad-name',
          column: 'label',
          definition: 'TEXT',
        }),
      kind: 'table',
      value: 'bad-name',
    })
  })

  test('throws InvalidIdentifierError with kind=column on invalid column name', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    expectInvalidIdentifierError({
      run: () =>
        migrateAddColumn({
          db,
          table: 'items',
          column: 'bad-col!',
          definition: 'TEXT',
        }),
      kind: 'column',
      value: 'bad-col!',
    })
  })

  test('throws InvalidColumnDefinitionError when definition contains a semicolon', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    let caught: unknown
    try {
      migrateAddColumn({
        db,
        table: 'items',
        column: 'label',
        definition: 'TEXT; DROP TABLE items; --',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidColumnDefinitionError)
    expect((caught as InvalidColumnDefinitionError).definition).toBe(
      'TEXT; DROP TABLE items; --',
    )
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
      .all()
      .map((row) => row.name)
    expect(tables).toContain('items')
  })
})

// ---------------------------------------------------------------------------
// migrateDropColumn
// ---------------------------------------------------------------------------

describe('migrateDropColumn', () => {
  test('drops a column that exists', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
    migrateDropColumn({ db, table: 'items', column: 'label' })
    const columns = listColumnNames('items')
    expect(columns).not.toContain('label')
    expect(columns).toContain('id')
  })

  test('is a no-op if the column is already gone', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    expect(() =>
      migrateDropColumn({ db, table: 'items', column: 'never_existed' }),
    ).not.toThrow()
  })

  test('throws MissingTableError when the target table does not exist', () => {
    const wrapped = expectMissingTableError({
      run: () =>
        migrateDropColumn({ db, table: 'nonexistent', column: 'label' }),
      table: 'nonexistent',
      operation: 'drop column',
    })
    expect(wrapped.message).toContain('table "nonexistent" does not exist')
  })

  test('matches column names case-insensitively (SQLite identifier semantics)', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
    // Caller passes `Label`; column was declared `label`. SQLite would treat
    // these as the same identifier in any query; this helper must too.
    migrateDropColumn({ db, table: 'items', column: 'Label' })
    const columns = listColumnNames('items')
    expect(columns).not.toContain('label')
  })

  test('propagates SQLite error when the column is referenced by an index', () => {
    // SQLite blocks DROP COLUMN when an index references the column. The
    // error must propagate unwrapped, and the column must remain so the
    // caller can drop the index and retry.
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)')
    db.run('CREATE INDEX idx_label ON items (label)')
    expect(() =>
      migrateDropColumn({ db, table: 'items', column: 'label' }),
    ).toThrow()
    const columns = listColumnNames('items')
    expect(columns).toContain('label')
  })

  test('throws InvalidIdentifierError with kind=table on invalid table name', () => {
    expectInvalidIdentifierError({
      run: () => migrateDropColumn({ db, table: 'bad-name', column: 'label' }),
      kind: 'table',
      value: 'bad-name',
    })
  })

  test('throws InvalidIdentifierError with kind=column on invalid column name', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    expectInvalidIdentifierError({
      run: () => migrateDropColumn({ db, table: 'items', column: 'bad-col!' }),
      kind: 'column',
      value: 'bad-col!',
    })
  })

  test('runs the backfill SQL before the drop', () => {
    db.run(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, old_name TEXT, new_name TEXT)',
    )
    db.run("INSERT INTO items VALUES (1, 'alpha', NULL)")
    db.run("INSERT INTO items VALUES (2, 'beta', 'already-set')")

    migrateDropColumn({
      db,
      table: 'items',
      column: 'old_name',
      backfill:
        'UPDATE items SET new_name = old_name WHERE new_name IS NULL AND old_name IS NOT NULL',
    })

    const rows = db
      .query<{ id: number; new_name: string }, []>(
        'SELECT id, new_name FROM items ORDER BY id',
      )
      .all()
    expect(rows).toEqual([
      { id: 1, new_name: 'alpha' },
      { id: 2, new_name: 'already-set' },
    ])
    const columns = listColumnNames('items')
    expect(columns).not.toContain('old_name')
  })

  test('skips the backfill when the column is already gone (idempotent retry)', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, new_name TEXT)')
    db.run("INSERT INTO items VALUES (1, 'preserved')")
    // Backfill references `old_name`, which no longer exists. If the helper
    // ran the backfill before checking column presence it would throw — the
    // idempotency check must short-circuit before touching the SQL.
    expect(() =>
      migrateDropColumn({
        db,
        table: 'items',
        column: 'old_name',
        backfill: 'UPDATE items SET new_name = old_name',
      }),
    ).not.toThrow()
    const row = db
      .query<{ new_name: string }, []>(
        'SELECT new_name FROM items WHERE id = 1',
      )
      .get()
    expect(row?.new_name).toBe('preserved')
  })

  test('does not run the drop if the backfill throws', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, old_name TEXT)')
    db.run("INSERT INTO items VALUES (1, 'data')")
    expect(() =>
      migrateDropColumn({
        db,
        table: 'items',
        column: 'old_name',
        backfill: 'NOT VALID SQL !!!',
      }),
    ).toThrow()
    // Drop must not have happened — the column is still there for retry.
    const columns = listColumnNames('items')
    expect(columns).toContain('old_name')
  })
})

// ---------------------------------------------------------------------------
// migrateRenameColumn
// ---------------------------------------------------------------------------

describe('migrateRenameColumn', () => {
  test('renames the legacy column when only it is present', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, ts TEXT)')
    migrateRenameColumn({ db, table: 'items', from: 'ts', to: 'timestamp' })
    const columns = listColumnNames('items')
    expect(columns).toContain('timestamp')
    expect(columns).not.toContain('ts')
  })

  test('preserves existing row data across the rename', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, ts TEXT)')
    db.run("INSERT INTO items (id, ts) VALUES (1, '2026-01-01T00:00:00Z')")
    migrateRenameColumn({ db, table: 'items', from: 'ts', to: 'timestamp' })
    const row = db
      .query<{ timestamp: string }, []>(
        'SELECT timestamp FROM items WHERE id = 1',
      )
      .get()
    expect(row?.timestamp).toBe('2026-01-01T00:00:00Z')
  })

  test('is a no-op when the new column already exists (fresh DB)', () => {
    // Mirrors a fresh DB whose generated DDL already named the column `timestamp`:
    // there is no `ts` column, so the bare rename would throw — the guard skips it.
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, timestamp TEXT)')
    expect(() =>
      migrateRenameColumn({ db, table: 'items', from: 'ts', to: 'timestamp' }),
    ).not.toThrow()
    const columns = listColumnNames('items')
    expect(columns).toContain('timestamp')
    expect(columns).not.toContain('ts')
  })

  test('is idempotent — a second call after a successful rename is a no-op', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, ts TEXT)')
    migrateRenameColumn({ db, table: 'items', from: 'ts', to: 'timestamp' })
    expect(() =>
      migrateRenameColumn({ db, table: 'items', from: 'ts', to: 'timestamp' }),
    ).not.toThrow()
  })

  test('matches the legacy column name case-insensitively', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, ts TEXT)')
    migrateRenameColumn({ db, table: 'items', from: 'TS', to: 'timestamp' })
    const columns = listColumnNames('items')
    expect(columns).toContain('timestamp')
  })

  test('throws MissingTableError when the target table does not exist', () => {
    expectMissingTableError({
      run: () =>
        migrateRenameColumn({
          db,
          table: 'nonexistent',
          from: 'ts',
          to: 'timestamp',
        }),
      table: 'nonexistent',
      operation: 'rename column',
    })
  })

  test('throws InvalidIdentifierError with kind=table on invalid table name', () => {
    expectInvalidIdentifierError({
      run: () =>
        migrateRenameColumn({
          db,
          table: 'bad-name',
          from: 'ts',
          to: 'timestamp',
        }),
      kind: 'table',
    })
  })

  test('throws InvalidIdentifierError with kind=column on an invalid target name', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, ts TEXT)')
    expectInvalidIdentifierError({
      run: () =>
        migrateRenameColumn({ db, table: 'items', from: 'ts', to: 'bad-col!' }),
      kind: 'column',
    })
  })
})

// ---------------------------------------------------------------------------
// execWrite
// ---------------------------------------------------------------------------

describe('execWrite', () => {
  test('commits changes when fn succeeds', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    execWrite(db, () => {
      db.run('INSERT INTO items VALUES (1)')
    })
    const row = db.query<{ id: number }, []>('SELECT id FROM items').get()
    expect(row?.id).toBe(1)
  })

  test('rolls back changes when fn throws', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    expect(() =>
      execWrite(db, () => {
        db.run('INSERT INTO items VALUES (1)')
        throw new Error('oops')
      }),
    ).toThrow('oops')
    const countRow = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM items')
      .get()
    expect(countRow?.count).toBe(0)
  })

  test('returns the value from fn', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    const result = execWrite(db, () => {
      db.run('INSERT INTO items VALUES (1)')
      return 42
    })
    expect(result).toBe(42)
  })

  test('throws TransactionRollbackError when ROLLBACK itself fails, preserving the original error', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    const adapter = {
      prepare: (sql: string) => {
        if (sql === 'ROLLBACK') {
          return {
            get: () => null,
            all: () => [],
            run: () => {
              throw new Error('rollback failed')
            },
          }
        }
        return db.prepare(sql)
      },
      transaction: <T>(fn: () => T) => db.transaction(fn),
    }
    let caught: unknown
    try {
      execWrite(adapter, () => {
        throw new Error('original')
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TransactionRollbackError)
    const wrapped = caught as TransactionRollbackError
    expect((wrapped.originalError as Error).message).toBe('original')
    expect((wrapped.rollbackError as Error).message).toBe('rollback failed')
  })

  test('rolls back a real SQLite constraint violation (UNIQUE) and reverts both writes', () => {
    db.run(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)',
    )
    db.run("INSERT INTO items VALUES (1, 'existing')")
    expect(() =>
      execWrite(db, () => {
        // First insert succeeds; second hits the UNIQUE constraint and the
        // driver throws SqliteError mid-transaction. The whole block must
        // roll back so neither write persists.
        db.run("INSERT INTO items VALUES (2, 'new')")
        db.run("INSERT INTO items VALUES (3, 'existing')")
      }),
    ).toThrow()
    const ids = db
      .query<{ id: number }, []>('SELECT id FROM items ORDER BY id')
      .all()
      .map((row) => row.id)
    expect(ids).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// defineWrite
// ---------------------------------------------------------------------------

/**
 * Params schema for the single-column `items(id)` insert the defineWrite tests
 * share. Named so {@link defineInsertItem} can declare an explicit return type
 * without restating the shape.
 */
const InsertItemParamsSchema = z.object({ id: z.number().int() })

/**
 * Builds the `INSERT INTO items VALUES ($id)` write handle the defineWrite
 * `.run()` and `.runInTransaction()` tests share. Replaces three identical
 * inline `defineWrite` blocks; couples them on the single `items(id)` insert
 * shape. Closes over the module-level `db` reassigned in `beforeEach`.
 */
function defineInsertItem(): WriteHandle<typeof InsertItemParamsSchema> {
  return defineWrite({
    db,
    params: InsertItemParamsSchema,
    sql: 'INSERT INTO items VALUES ($id)',
  })
}

describe('defineWrite — .run()', () => {
  test('inserts a row and returns { changes, lastInsertRowid }', () => {
    db.run(`CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    )`)
    const insertNote = defineWrite({
      db,
      params: z.object({ title: z.string() }),
      sql: 'INSERT INTO notes (title) VALUES ($title)',
    })
    const result = insertNote.run({ title: 'First' })
    expect(result.changes).toBe(1)
    expect(Number(result.lastInsertRowid)).toBe(1)

    const second = insertNote.run({ title: 'Second' })
    expect(second.changes).toBe(1)
    expect(Number(second.lastInsertRowid)).toBe(2)
  })

  test('reports changes for UPDATE matching multiple rows', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, done INTEGER NOT NULL)')
    db.run('INSERT INTO items VALUES (1, 0), (2, 0), (3, 1)')
    const markAllDone = defineWrite({
      db,
      params: z.object({}),
      sql: 'UPDATE items SET done = 1 WHERE done = 0',
    })
    const result = markAllDone.run({})
    expect(result.changes).toBe(2)
  })

  test('reports zero changes for DELETE matching nothing', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    const deleteMissing = defineWrite({
      db,
      params: z.object({ id: z.number().int() }),
      sql: 'DELETE FROM items WHERE id = $id',
    })
    const result = deleteMissing.run({ id: 999 })
    expect(result.changes).toBe(0)
  })

  test('validates params via Zod before binding (rejects bad shape)', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    const insertItem = defineInsertItem()
    // @ts-expect-error — intentionally passing wrong type to confirm Zod rejects
    expect(() => insertItem.run({ id: 'not-a-number' })).toThrow()
  })

  test('serializes boolean params to 0/1 like defineQuery does', () => {
    db.run(
      'CREATE TABLE flags (id INTEGER PRIMARY KEY, active INTEGER NOT NULL)',
    )
    const insertFlag = defineWrite({
      db,
      params: z.object({ id: z.number().int(), active: z.boolean() }),
      sql: 'INSERT INTO flags VALUES ($id, $active)',
    })
    insertFlag.run({ id: 1, active: true })
    insertFlag.run({ id: 2, active: false })
    const rows = db
      .query<{ active: number }, []>('SELECT active FROM flags ORDER BY id')
      .all()
    expect(rows.map((r) => r.active)).toEqual([1, 0])
  })
})

describe('defineWrite — .runInTransaction()', () => {
  test('commits the statement on success and returns the result', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    const insertItem = defineInsertItem()
    const result = insertItem.runInTransaction({ id: 1 })
    expect(result.changes).toBe(1)
    const row = db.query<{ id: number }, []>('SELECT id FROM items').get()
    expect(row?.id).toBe(1)
  })

  test('rolls back when the statement throws (UNIQUE violation)', () => {
    db.run(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL)',
    )
    db.run("INSERT INTO items VALUES (1, 'existing')")
    const insertItem = defineWrite({
      db,
      params: z.object({ id: z.number().int(), label: z.string() }),
      sql: 'INSERT INTO items VALUES ($id, $label)',
    })
    expect(() =>
      insertItem.runInTransaction({ id: 2, label: 'existing' }),
    ).toThrow()
    const countRow = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM items')
      .get()
    expect(countRow?.count).toBe(1)
  })

  test('rolls back and rethrows when Zod validation fails', () => {
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY)')
    const insertItem = defineInsertItem()
    // @ts-expect-error — bad shape, BEGIN IMMEDIATE fires before parse so ROLLBACK runs
    expect(() => insertItem.runInTransaction({ id: 'not-a-number' })).toThrow()
    const countRow = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM items')
      .get()
    expect(countRow?.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// defineDynamicQuery
// ---------------------------------------------------------------------------

describe('defineDynamicQuery', () => {
  function seedSessions(): void {
    db.run(`CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      total_tokens INTEGER NOT NULL,
      started_at TEXT NOT NULL
    )`)
    db.run(`INSERT INTO sessions VALUES
      ('s1', '/a', 100, '2026-01-01T00:00:00.000Z'),
      ('s2', '/a', 50, '2026-01-02T00:00:00.000Z'),
      ('s3', '/b', 200, '2026-01-03T00:00:00.000Z')`)
  }

  const SessionRowSchema = z.object({
    session_id: z.string(),
    cwd: z.string(),
    total_tokens: z.number().int(),
    started_at: z.iso.datetime(),
  })

  /**
   * Builds a {@link SqliteAdapter} that delegates to the real `db` but counts
   * how many times `prepare` is called, so the statement-caching tests can
   * assert reuse. Replaces two identical inline `let prepareCount = 0; const
   * adapter = {...}` blocks; the returned getter exposes the live count, which
   * the tests read after each `.all()` call. Couples those copies on the one
   * way this suite instruments prepare().
   */
  function makeCountingAdapter(): {
    adapter: SqliteAdapter
    getPrepareCount: () => number
  } {
    let prepareCount = 0
    const adapter: SqliteAdapter = {
      prepare: (sql: string) => {
        prepareCount += 1
        return db.prepare(sql)
      },
      transaction: <CallbackResult>(fn: () => CallbackResult) =>
        db.transaction(fn),
    }
    return { adapter, getPrepareCount: () => prepareCount }
  }

  test('composes no WHERE / no ORDER BY → base SELECT', () => {
    seedSessions()
    const list = defineDynamicQuery({
      db,
      params: z.object({}),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
    })
    const rows = list.all({ params: {} })
    expect(rows.length).toBe(3)
  })

  test('activates a single WHERE fragment', () => {
    seedSessions()
    const list = defineDynamicQuery({
      db,
      params: z.object({ cwd: z.string() }),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      where: { cwd: 'cwd = $cwd' },
    })
    const rows = list.all({ params: { cwd: '/a' }, where: ['cwd'] })
    expect(rows.map((row) => row.session_id).sort()).toEqual(['s1', 's2'])
  })

  test('AND-joins multiple WHERE fragments', () => {
    seedSessions()
    const list = defineDynamicQuery({
      db,
      params: z.object({ cwd: z.string(), min_tokens: z.number().int() }),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      where: {
        cwd: 'cwd = $cwd',
        minTokens: 'total_tokens >= $min_tokens',
      },
    })
    const rows = list.all({
      params: { cwd: '/a', min_tokens: 75 },
      where: ['cwd', 'minTokens'],
    })
    expect(rows.map((row) => row.session_id)).toEqual(['s1'])
  })

  test('omits inactive WHERE fragments (no IS NULL OR …)', () => {
    seedSessions()
    const list = defineDynamicQuery({
      db,
      params: z.object({ cwd: z.string().nullable() }),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      where: { cwd: 'cwd = $cwd' },
    })
    // cwd is null in params but we don't activate the fragment — all rows returned
    const rows = list.all({ params: { cwd: null } })
    expect(rows.length).toBe(3)
  })

  test('applies ORDER BY from the named alias', () => {
    seedSessions()
    const list = defineDynamicQuery({
      db,
      params: z.object({}),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      order: {
        tokens: 'total_tokens DESC',
        oldest: 'started_at ASC',
      },
    })
    const byTokens = list.all({ params: {}, orderBy: 'tokens' })
    expect(byTokens.map((row) => row.session_id)).toEqual(['s3', 's1', 's2'])
    const byOldest = list.all({ params: {}, orderBy: 'oldest' })
    expect(byOldest.map((row) => row.session_id)).toEqual(['s1', 's2', 's3'])
  })

  test('caches the prepared statement per (where, orderBy) signature', () => {
    seedSessions()
    const { adapter, getPrepareCount } = makeCountingAdapter()
    const list = defineDynamicQuery({
      db: adapter,
      params: z.object({ cwd: z.string() }),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      where: { cwd: 'cwd = $cwd' },
      order: { tokens: 'total_tokens DESC' },
    })
    list.all({ params: { cwd: '/a' }, where: ['cwd'] })
    list.all({ params: { cwd: '/b' }, where: ['cwd'] })
    expect(getPrepareCount()).toBe(1)
    list.all({ params: { cwd: '/a' }, where: ['cwd'], orderBy: 'tokens' })
    expect(getPrepareCount()).toBe(2)
  })

  test('one() returns null on no match, parsed row on match', () => {
    seedSessions()
    const find = defineDynamicQuery({
      db,
      params: z.object({ session_id: z.string() }),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      where: { byId: 'session_id = $session_id' },
    })
    expect(
      find.one({ params: { session_id: 'missing' }, where: ['byId'] }),
    ).toBeNull()
    const row = find.one({ params: { session_id: 's1' }, where: ['byId'] })
    expect(row?.session_id).toBe('s1')
  })

  test('order of activeWhere does not change the cached statement', () => {
    seedSessions()
    const { adapter, getPrepareCount } = makeCountingAdapter()
    const list = defineDynamicQuery({
      db: adapter,
      params: z.object({ cwd: z.string(), min_tokens: z.number().int() }),
      result: SessionRowSchema,
      sql: 'SELECT * FROM sessions',
      where: {
        cwd: 'cwd = $cwd',
        minTokens: 'total_tokens >= $min_tokens',
      },
    })
    list.all({
      params: { cwd: '/a', min_tokens: 0 },
      where: ['cwd', 'minTokens'],
    })
    list.all({
      params: { cwd: '/a', min_tokens: 0 },
      where: ['minTokens', 'cwd'],
    })
    expect(getPrepareCount()).toBe(1)
  })
})

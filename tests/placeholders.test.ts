import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import {
  createInsertSchema,
  defineDynamicQuery,
  defineQuery,
  defineWrite,
  PlaceholderMismatchError,
} from '../src/index'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.run(
    'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, active INTEGER NOT NULL DEFAULT 1)',
  )
})

const RowResult = z.object({ id: z.number().int(), name: z.string() })

// ---------------------------------------------------------------------------
// defineQuery / defineWrite — the fatal (throwing) directions
// ---------------------------------------------------------------------------

describe('assertStaticPlaceholders — throws', () => {
  test('a $placeholder with no matching param throws PlaceholderMismatchError', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = $id AND name = $name',
      }),
    ).toThrow(PlaceholderMismatchError)
  })

  test('a $name typo (schema key differs) throws and reports the missing placeholder', () => {
    let caught: unknown
    try {
      defineQuery({
        db,
        // Schema key is `bookId`; SQL references `$id`.
        params: z.object({ bookId: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = $id',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlaceholderMismatchError)
    expect((caught as PlaceholderMismatchError).missingParams).toEqual(['id'])
  })

  test('a foreign :name placeholder throws and is reported as foreign', () => {
    let caught: unknown
    try {
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = :id',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlaceholderMismatchError)
    expect((caught as PlaceholderMismatchError).foreignPlaceholders).toEqual([
      ':id',
    ])
  })

  test('a foreign @name placeholder throws', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = @id',
      }),
    ).toThrow(PlaceholderMismatchError)
  })

  test('a foreign ? positional placeholder throws', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = ?',
      }),
    ).toThrow(PlaceholderMismatchError)
  })

  test('defineWrite runs the same check', () => {
    expect(() =>
      defineWrite({
        db,
        params: z.object({ id: z.number().int() }),
        sql: 'INSERT INTO t (id, name) VALUES ($id, $name)',
      }),
    ).toThrow(PlaceholderMismatchError)
  })
})

// ---------------------------------------------------------------------------
// Stripper — $ inside literals and comments must NOT count as placeholders
// ---------------------------------------------------------------------------

describe('assertStaticPlaceholders — literal/comment stripping', () => {
  test('a $token inside a string literal is not a placeholder', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: "SELECT *, '$fake' AS marker FROM t WHERE id = $id",
      }),
    ).not.toThrow()
  })

  test('a $token inside a line comment is ignored', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = $id -- filter by $notaparam',
      }),
    ).not.toThrow()
  })

  test('a $token inside a block comment is ignored', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT /* $nope */ * FROM t WHERE id = $id',
      }),
    ).not.toThrow()
  })

  test('an escaped single quote inside a literal does not leak a false placeholder', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: "SELECT *, 'it''s $notaparam' AS marker FROM t WHERE id = $id",
      }),
    ).not.toThrow()
  })

  test('a parameterless statement passes', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({}),
        result: z.object({ one: z.number().int() }),
        sql: 'SELECT 1 AS one',
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Unused-param direction — required warns, optional stays silent
// ---------------------------------------------------------------------------

describe('assertStaticPlaceholders — unused params', () => {
  test('a required param never bound in SQL warns (does not throw)', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int(), name: z.string() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = $id',
      }),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('name')
  })

  test('an optional param never bound stays silent — the documented DB-default fall-through', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    // `active` has a default → createInsertSchema makes it optional; the INSERT
    // deliberately omits it so the DB default applies. This is the pattern
    // recipes.md recommends and it must not warn.
    const BaseSchema = z.object({
      id: z.number().int(),
      active: z.boolean().default(true),
    })
    expect(() =>
      defineWrite({
        db,
        params: createInsertSchema(BaseSchema),
        sql: 'INSERT INTO t (id) VALUES ($id)',
      }),
    ).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

describe('skipPlaceholderCheck', () => {
  test('bypasses a would-be throw', () => {
    expect(() =>
      defineQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t WHERE id = :id',
        skipPlaceholderCheck: true,
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// defineDynamicQuery — union of base + fragments, missing-direction only
// ---------------------------------------------------------------------------

describe('assertDynamicPlaceholders', () => {
  test('a param serving an inactive fragment is not flagged as missing', () => {
    // `author` and `min` are used only by where fragments — never by the base
    // SQL — yet both are declared. The union check must accept them.
    expect(() =>
      defineDynamicQuery({
        db,
        params: z.object({ id: z.number().int(), name: z.string() }),
        result: RowResult,
        sql: 'SELECT * FROM t',
        where: {
          byId: 'id = $id',
          byName: 'name = $name',
        },
      }),
    ).not.toThrow()
  })

  test('a fragment referencing an undeclared param throws', () => {
    expect(() =>
      defineDynamicQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t',
        // `$naem` is a typo — no such param.
        where: { byName: 'name = $naem' },
      }),
    ).toThrow(PlaceholderMismatchError)
  })

  test('a foreign placeholder in a fragment throws', () => {
    expect(() =>
      defineDynamicQuery({
        db,
        params: z.object({ id: z.number().int() }),
        result: RowResult,
        sql: 'SELECT * FROM t',
        where: { byId: 'id = :id' },
      }),
    ).toThrow(PlaceholderMismatchError)
  })

  test('does not warn on unused params (unused direction is skipped for dynamic)', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    defineDynamicQuery({
      db,
      params: z.object({ id: z.number().int(), name: z.string() }),
      result: RowResult,
      sql: 'SELECT * FROM t',
      where: { byId: 'id = $id' },
    })
    expect(warn).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  // Restore any console.warn spy installed by a test.
  const warn = console.warn as unknown as { mockRestore?: () => void }
  warn.mockRestore?.()
})

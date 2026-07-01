# zqlite

Schema-first SQLite for TypeScript. Write a Zod schema once — get the DDL,
the TypeScript types, and validated queries from it, with no redundancy and no
ORM.

```ts
import { z } from 'zod'
import { defineQuery, zodToSqliteDDL } from 'zqlite'

const SessionSchema = z.object({
  session_id: z.string(),
  model: z.string(),
  total_tokens: z.number().int(),
  is_active: z.boolean(),
})

// CREATE TABLE, derived from the schema
const ddl = zodToSqliteDDL({
  table: 'sessions',
  schema: SessionSchema,
  primaryKey: ['session_id'],
})

// Type-safe query — params validated in, rows coerced + validated out
const findSession = defineQuery({
  db,
  params: z.object({ session_id: z.string() }),
  result: SessionSchema,
  sql: 'SELECT * FROM sessions WHERE session_id = $session_id',
})

const session = findSession.one({ session_id: 'abc' })
// session: Session | null — is_active is a real boolean, not 0
```

## Why

SQLite in TypeScript is usually raw `db.prepare(...).get(...)` with `as YourType`
casts. That works until a column type changes, a boolean comes back as `0`, or a
JSON field arrives as a string — bugs at the DB boundary are silent and only
surface at runtime.

zqlite makes the schema the single source of truth:

- **One schema** defines the TypeScript types, the `CREATE TABLE`, and query
  validation.
- **Both boundaries validated** — params before binding, rows before returning.
- **Automatic coercion** — `boolean` ↔ `0`/`1`, `Date` ↔ ISO string, JSON
  columns ↔ parsed objects.
- **Not an ORM** — you write the SQL. zqlite owns the type boundary, not the
  query. No entities, no relations, no query DSL.

## Documentation

| Guide | For |
|---|---|
| **[Getting started](./docs/getting-started.md)** | Zero to a working table in 5 minutes |
| **[Recipes](./docs/recipes.md)** | Task-oriented patterns: writes, dynamic queries, JSON, migrations, drivers |
| **[API reference](./docs/api-reference.md)** | Every export, option, and error |
| **[Examples](./examples)** | Runnable, progressively numbered (`bun examples/01-quickstart.ts`) |

## Install

```bash
# Bun (recommended — bun:sqlite is built in)
bun add zqlite zod

# Node, with better-sqlite3
npm install zqlite zod better-sqlite3
```

Requires a supported SQLite driver and [Zod](https://zod.dev) ^4 (peer
dependency).

## Drivers

| Driver | Status | Notes |
|---|---|---|
| [`bun:sqlite`](https://bun.sh/docs/api/sqlite) | **Tested** | Pass `new Database(path)` directly |
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | **Tested** | Set `paramPrefix: ''` on the connection |
| [`node:sqlite`](https://nodejs.org/docs/latest/api/sqlite.html) (Node 22+) | **Tested** | Needs a thin wrapper (no `.transaction()`) |

All three drivers run the same integration suite in CI: `bun:sqlite` under Bun,
`better-sqlite3` and `node:sqlite` under Node 22 and 24. (`better-sqlite3` is
Node-only — Bun does not support its native addon.)

Driver setup details are in
[recipes.md → Multiple drivers](./docs/recipes.md#multiple-drivers).

## Limitations

- **Named params only** — SQL uses `$name` placeholders; positional `?` is not
  supported.
- **Flat schemas** — `ZodObject` / `ZodArray` fields must use `zJsonSchema`;
  nested schemas are not auto-flattened.
- **No index generation** — define indexes alongside `zodToSqliteDDL` output.
- **Sync only** — all supported drivers and all methods are synchronous.

## Status

zqlite is currently developed inside the `command-center` monorepo. The API is
stable in practice but predates a formal release; pin to a commit if you depend
on it externally.

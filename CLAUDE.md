# zqlite — project guide

Schema-first SQLite for TypeScript: one Zod schema yields the DDL, the types,
and validated queries. Driver-agnostic — everything routes through the
`SqliteAdapter` interface in [src/types.ts](src/types.ts). Not an ORM; you write
the SQL.

## Import convention — `.js` extensions in `src/` are mandatory

Relative imports and re-exports inside `src/` **must end in `.js`**, even though
the files on disk are `.ts`:

```ts
import { serializeRow } from './serialize.js'   // correct
import { serializeRow } from './serialize'       // WRONG — breaks the build
```

Why: `tsc` copies import specifiers verbatim into `dist/`. Extensionless
specifiers produce `dist/index.js` that Node's ESM resolver rejects
(`ERR_MODULE_NOT_FOUND`), so the published package fails to load — even though
`moduleResolution: bundler` resolves the `.js` back to the `.ts` at dev time and
every source-level test stays green. **An extensionless import is invisible to
`bun test` and `bun run test:node`; only `bun run test:node:dist` catches it.**
When you add a new `src/` file, use `.js` on its imports.

## Commands and what each proves

| Command | Runtime | Proves |
|---|---|---|
| `bun test` | Bun | Unit suite + `bun:sqlite` driver parity |
| `bun run test:node` | Node | `better-sqlite3` + `node:sqlite` parity, against **source** (via tsx) |
| `bun run test:node:dist` | Node | Builds, checks the **dist artifact loads under plain Node** (no tsx), then runs parity against dist |
| `bun run test:all` | Bun + Node | `test` + `test:node` (the fast, source-level gate) |
| `bun run build` | — | `tsc` → `dist/` |
| `bun x tsc --noEmit -p tsconfig.json` | — | Typecheck (includes `src/` and `examples/`) |

"Seen it run" (per the-craft): a typecheck or `bun test` passing does **not**
prove the shipped package works — run `test:node:dist` before claiming the
artifact is sound.

## Driver × runtime matrix

The parity suite is sparse by design — no driver runs everywhere:

| Runtime | `bun:sqlite` | `better-sqlite3` | `node:sqlite` | `libsql` |
|---|---|---|---|---|
| Bun | ✅ | ❌ Bun rejects its native addon | ❌ | ✅ |
| Node 22+ | ❌ | ✅ | ✅ (built in) | ✅ |

`libsql` covers **local** databases only; Turso cloud needs async support (see
`spikes/libsql-turso/`). Three libsql gotchas, all handled:

1. It binds bare keys (`paramPrefix: ''`).
2. It leaves a result-returning statement's cursor open after `.run()` — so
   `configureZqliteAdapter` issues setup PRAGMAs via a one-shot
   (`SqliteAdapter.exec`, or bun's `run`), never `prepare().run()`, or a later
   `COMMIT` fails with "SQL statements in progress".
3. It injects a `_metadata` field into every `.get()` row. Non-strict result
   schemas (the default) drop it, but a `.strict()` schema rejects it — so libsql
   is used through the `adaptLibsql` wrapper (test factory in
   `tests/integration/adapters.ts`; documented in `docs/recipes.md`) that strips
   `_metadata`. The `.strict()` parity test guards this.

The adapter registry ([tests/integration/adapters.ts](tests/integration/adapters.ts))
probes each driver by *constructing* a connection (importing is not enough —
`better-sqlite3` imports under Bun but throws on construction) and
`assertExpectedAdapters` fails loudly if an expected driver is missing, so a
broken build can't silently shrink coverage to a green run.

## Test architecture

- [tests/zqlite.test.ts](tests/zqlite.test.ts) — comprehensive `bun:test` unit
  suite (the behavioral gold standard).
- [tests/integration/](tests/integration/) — cross-driver **parity** suite. One
  parameterized body ([suite.ts](tests/integration/suite.ts)) is registered per
  driver by per-runtime entries: `bun.test.ts` (Bun), `node-entry.ts` (Node,
  source), `node-dist-entry.ts` (Node, dist). `dist-load-check.mjs` is a
  plain-Node (no tsx) load check so tsx can't mask a broken artifact.
- Assertions use `node:assert` (works under both runners) with **strict**
  equality — loose `assert.equal` treats `1 == true` and would hide the exact
  boolean-coercion bug the suite exists to catch.

The Node entry `node-entry.ts` is deliberately **not** named `*.test.ts` so
Bun's test glob never executes it (it imports `node:sqlite`, absent in Bun).

## Package manager

Use **bun**. The lockfile is `bun.lock`; CI runs `bun install --frozen-lockfile`.
Do not reintroduce `package-lock.json` — an `npm install` from it diverges from
`bun.lock` and has silently removed devDeps (e.g. `tsx`) mid-work.

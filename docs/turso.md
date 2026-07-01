# Turso cloud (async)

zqlite talks to a remote [Turso](https://turso.tech) database through its
**async API** — `defineAsyncQuery`, `defineAsyncWrite`, and `execWriteAsync`,
over [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts).

Remote access is asynchronous (each statement is a network round-trip), so it
can't use the synchronous drivers. The async API is a *parallel* surface: same
Zod schema, same param validation, same boolean / `Date` / JSON coercion, same
`$name` placeholder rule — the calls just return Promises. The synchronous
drivers keep the synchronous API; nothing about them changes.

> **libsql has two modes.** The `libsql` package is a *local*, synchronous
> driver (see [recipes.md → Multiple drivers](./recipes.md#multiple-drivers)).
> *Turso cloud* is the *remote*, asynchronous path documented here, and uses
> `@libsql/client`, not `libsql`.

## Install

```bash
bun add @libsql/client
# or: npm install @libsql/client
```

`@libsql/client` is yours to bring, like any driver — zqlite's async code
depends on the `AsyncSqliteAdapter` interface, not on the client directly.

## Credentials — use a *database* auth token

Two Turso token types look alike (both are JWTs) but do different jobs:

| Token | What it's for | Works as `authToken`? |
|---|---|---|
| **Database auth token** | Authenticates the `libsql://` data connection | ✅ yes |
| **Platform API token** | Manages your Turso account (create/delete DBs) | ❌ no — returns HTTP 401 |

A Platform API token is a valid JWT and *looks* fine, but the data connection
rejects it with `401`. Mint a **database** token:

```bash
turso db tokens create <your-database-name>
```

Keep it out of source control — put `DB_URL` / `TURSO_AUTH_TOKEN` in `.env` (and
gitignore `.env`).

## Connect

`@libsql/client`'s `Client` satisfies `AsyncSqliteAdapter` directly — no wrapper.

```ts
import { createClient } from '@libsql/client'

const db = createClient({
  url: process.env.TURSO_DATABASE_URL, // libsql://<db>.turso.io
  authToken: process.env.TURSO_AUTH_TOKEN, // a database auth token (see above)
})
```

## Queries and writes

Identical to the sync API, but `await` the calls:

```ts
import { defineAsyncQuery, defineAsyncWrite } from 'zqlite'

const findBook = defineAsyncQuery({
  db,
  params: z.object({ book_id: z.string() }),
  result: BookSchema,
  sql: 'SELECT * FROM books WHERE book_id = $book_id',
})
const book = await findBook.one({ book_id: 'bk_1' }) // Book | null, fully coerced

const lendBook = defineAsyncWrite({
  db,
  params: z.object({ book_id: z.string(), borrower: z.string() }),
  sql: 'UPDATE books SET borrower = $borrower WHERE book_id = $book_id',
})
const { changes } = await lendBook.run({ book_id: 'bk_1', borrower: 'ada' })
```

Booleans come back as booleans, `Date`s as `Date`s, JSON columns as parsed
objects — the same coercion as the sync path. `$name` placeholders are
cross-checked against the params schema at define time, exactly as in the sync
API.

## Transactions

`execWriteAsync` opens an interactive transaction and hands it to your callback.
Run write handles against that `tx` (their second argument) to enlist them:

```ts
import { execWriteAsync } from 'zqlite'

await execWriteAsync(db, async (tx) => {
  await lendBook.run({ book_id: 'bk_1', borrower: 'ada' }, tx)
  await logActivity.run({ detail: 'bk_1 lent to ada' }, tx)
})
// both commit together, or both roll back if the callback throws
```

If the callback throws, the transaction rolls back and the error is re-thrown.
If the **rollback itself** fails — a real risk over the network (a drop
mid-rollback) — `execWriteAsync` throws `TransactionRollbackError` carrying both
the original error and the rollback failure, so the rollback failure never
silently masks the original and you know the database may be in an indeterminate
state. This is the same contract as the synchronous `execWrite`.

## Latency, and when to use `batch()`

Every statement is a network round-trip. An interactive transaction therefore
costs one round-trip per statement (plus begin/commit) — reach for
`execWriteAsync` when you need read-your-writes or conditional logic between
writes. For a batch of writes that don't read between them, `@libsql/client`'s
own `batch()` sends them in a single round-trip; use that instead.

## Local development

The async API works against a local `file:` database too — handy for tests and
offline development without provisioning Turso:

```ts
const db = createClient({ url: 'file:local.db' })
```

> **`:memory:` doesn't work with `@libsql/client`.** Each `:memory:` call gets a
> fresh connection, so a table created in one call is invisible to the next and
> transactions can't see it. Use a `file:` URL locally, or a real `libsql://`
> URL — both are one logical database.

## See also

- Runnable example: [`examples/07-turso-cloud.ts`](../examples/07-turso-cloud.ts)
  (runs on a local file by default; set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`
  to point at real Turso).
- [API reference → Async](./api-reference.md#async-turso-cloud) for every export.
- [recipes.md → Async & Turso cloud](./recipes.md#async--turso-cloud) for the
  condensed version.

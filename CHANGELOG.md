# Changelog

All notable changes to zqlite are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`libsql` (local) as a tested driver.** Turso's SQLite fork runs the full
  driver-parity suite under both Bun and Node. It needs a thin wrapper —
  `paramPrefix: ''` plus a strip of the `_metadata` field libsql injects into
  `.get()` rows (so `.strict()` result schemas work) — documented in
  [docs/recipes.md → Multiple drivers](./docs/recipes.md#multiple-drivers).
  Local databases only; Turso cloud (remote / embedded replica) is not yet
  supported because it requires async, and zqlite is currently sync-only.
- **Cross-driver, cross-runtime integration test suite.** `bun:sqlite`,
  `better-sqlite3`, `node:sqlite`, and `libsql` run one shared parity suite in
  CI — `bun:sqlite` and `libsql` under Bun; `better-sqlite3`, `node:sqlite`, and
  `libsql` under Node 22 and 24.

### Changed

- **BREAKING: `SqliteAdapter` now requires an `exec(sql): void` method.** It is
  used to issue connection-setup PRAGMAs as one-shot statements (some drivers,
  notably libsql, leave a prepared statement's cursor open after `.run()`, which
  blocks a later `COMMIT`). All supported native drivers — `bun:sqlite`,
  `better-sqlite3`, `node:sqlite`, `libsql` — already provide `exec`, so passing
  a native connection is unaffected. **Custom adapters must add an `exec`
  method**; see the `node:sqlite` and `libsql` wrappers in
  [docs/recipes.md](./docs/recipes.md#multiple-drivers).
- **BREAKING: SQL placeholders are cross-checked against the params schema at
  definition time.** `defineQuery` and `defineWrite` now throw
  `PlaceholderMismatchError` when a `$name` placeholder has no matching key in
  the params schema, or when a non-`$name` placeholder syntax is used (`:name`,
  `@name`, or positional `?`). Previously a name mismatch bound `NULL` silently
  on `bun:sqlite` while throwing on `node:sqlite` / `better-sqlite3`; the check
  makes that failure eager and uniform across drivers. Pass
  `skipPlaceholderCheck: true` to opt out for a specific handle.

### Fixed

- **The published `dist/` build now loads under plain Node.** Relative import
  specifiers in the source carry explicit `.js` extensions, so the ESM that
  `tsc` emits resolves under Node's module resolver instead of failing with
  `ERR_MODULE_NOT_FOUND`.

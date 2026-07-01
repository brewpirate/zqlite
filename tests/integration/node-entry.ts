import { beforeEach, describe, test } from 'node:test'
import * as zqlite from '../../src/index'
import { assertExpectedAdapters, getAvailableAdapters } from './adapters'
import { defineIntegrationSuite } from './suite'

/**
 * Drivers Node is required to host. node:sqlite is built into Node 22+;
 * better-sqlite3 and libsql are devDependencies we control — so a failed native
 * build must fail the run rather than silently dropping coverage.
 */
const EXPECTED_DRIVERS_UNDER_NODE = ['better-sqlite3', 'node:sqlite', 'libsql']

/**
 * Node-runtime entry point for the driver-parity suite, run against the
 * TypeScript **source** (the fast inner loop). Invoke via
 * `node --import tsx --test tests/integration/node-entry.ts` — NOT named
 * `*.test.ts`, so Bun's test glob never picks it up (it imports `node:sqlite`,
 * absent in Bun, which would fail the Bun run on import).
 *
 * Its sibling `node-dist-entry.ts` runs the same suite against the compiled
 * `dist/` build to verify the published artifact; this file is the quick
 * source-level check that needs no build step.
 *
 * Registers the shared suite once per driver Node can host — `node:sqlite`
 * (built in on Node 22+) and `better-sqlite3` (when installed).
 *
 * `tsx` is required as the loader: this suite imports the `.ts` source, whose
 * relative imports carry `.js` specifiers that resolve to sibling `.ts` files.
 * tsx maps `.js` -> `.ts`; Node's native type-stripping would look for a real
 * `.js` on disk and fail. (The `.js` specifiers are what makes the *compiled*
 * dist/ load cleanly under plain Node — see `node-dist-entry.ts`.)
 */

const adapters = await getAvailableAdapters()
assertExpectedAdapters(adapters, EXPECTED_DRIVERS_UNDER_NODE, 'Node')

for (const adapter of adapters) {
  defineIntegrationSuite(adapter, { describe, test, beforeEach }, zqlite)
}

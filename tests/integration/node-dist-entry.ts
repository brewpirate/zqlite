import { beforeEach, describe, test } from 'node:test'
// Import the library BY PACKAGE NAME, not by path — this resolves through the
// package `exports` map to the compiled `dist/` build, so the parity suite runs
// against the exact artifact a consumer installs (compiled JS + exports wiring),
// not the TypeScript source. Its sibling `node-entry.ts` tests the source.
import * as zqlite from 'zqlite'
import { assertExpectedAdapters, getAvailableAdapters } from './adapters'
import { defineIntegrationSuite } from './suite'

/**
 * Node-runtime entry point that runs the driver-parity suite against the
 * compiled `dist/` build. Run via `bun run test:node:dist`, which builds first.
 *
 * IMPORTANT — this file runs under `tsx` (it is TypeScript), and tsx patches
 * Node's module resolver globally. That patch will resolve extensionless
 * imports inside `dist/*.js` that PLAIN Node would reject — so a green run here
 * does NOT prove the artifact loads under a real consumer's Node. The
 * `test:node:dist` script therefore runs a separate plain-node load check
 * (no tsx) FIRST; this suite only validates that the compiled logic behaves.
 *
 * NOT named `*.test.ts`, so Bun's test glob never executes it.
 */
const EXPECTED_DRIVERS_UNDER_NODE = ['better-sqlite3', 'node:sqlite']

const adapters = await getAvailableAdapters()
assertExpectedAdapters(adapters, EXPECTED_DRIVERS_UNDER_NODE, 'Node (dist)')

for (const adapter of adapters) {
  defineIntegrationSuite(adapter, { describe, test, beforeEach }, zqlite)
}

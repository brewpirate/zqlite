import { beforeEach, describe, test } from 'bun:test'
import * as zqlite from '../../src/index'
import { assertExpectedAdapters, getAvailableAdapters } from './adapters'
import { defineIntegrationSuite } from './suite'

/** Drivers Bun is required to host — Bun ships bun:sqlite and nothing else here. */
const EXPECTED_DRIVERS_UNDER_BUN = ['bun:sqlite']

/**
 * Bun-runtime entry point for the driver-parity suite. Named `*.test.ts` so
 * `bun test` discovers it. Registers the shared suite once per driver Bun can
 * host — in practice only `bun:sqlite`, since Bun rejects `better-sqlite3` and
 * has no `node:sqlite`.
 *
 * The Node entry point is deliberately named `node-entry.ts` (not `*.test.ts`)
 * so `bun test` does not try to execute it — it imports `node:sqlite`, which
 * Bun does not implement, and would fail the whole Bun run on import.
 */

const adapters = await getAvailableAdapters()
assertExpectedAdapters(adapters, EXPECTED_DRIVERS_UNDER_BUN, 'Bun')

for (const adapter of adapters) {
  defineIntegrationSuite(adapter, { describe, test, beforeEach }, zqlite)
}

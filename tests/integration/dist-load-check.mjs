// Plain-Node load check for the published dist/ artifact. Intentionally a .mjs
// file with NO tsx loader: it must run under exactly the module resolver a real
// consumer's Node uses, so a dist build with unresolvable imports (e.g.
// extensionless `./bool` that Node ESM rejects) fails here instead of being
// silently masked by tsx's global resolver patch.
//
// Imports zqlite BY PACKAGE NAME so the package `exports` map is exercised too —
// a wrong or missing `exports` target fails this check.
//
// Run via `node tests/integration/dist-load-check.mjs` after building. Exits
// non-zero with a clear message on failure so it can gate `test:node:dist`.

const REQUIRED_EXPORT = 'defineQuery'

try {
  const zqlite = await import('zqlite')
  if (typeof zqlite[REQUIRED_EXPORT] !== 'function') {
    throw new Error(
      `dist loaded but is missing the '${REQUIRED_EXPORT}' export — the exports map or build output is wrong.`,
    )
  }
  console.log(
    '[dist load check] OK — zqlite resolves and loads under plain Node.',
  )
} catch (error) {
  console.error(
    '[dist load check] FAILED — the published dist/ artifact does not load under plain Node:',
  )
  console.error(error)
  process.exit(1)
}

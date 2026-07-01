#!/usr/bin/env tsx
// Single repo-wide gate. One ordered list of checks spanning every workspace
// package (types, oxfmt format/lint, the discipline checks, and the full test
// suites). `check:all` delegates here, and both the pre-commit hook and CI
// invoke `check:all` — so one list is the single source of what "green" means
// everywhere. Adding a check here covers all callers.
//
// Ordering is cheap-first: a fast static failure (format, types) surfaces before
// the expensive build + test gates run.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * @typedef {object} Gate
 * @property {string} name Short identifier shown in progress + summary.
 * @property {string} describe One-line human description.
 * @property {string[]} command argv — `command[0]` is the binary, the rest are args.
 */

/**
 * Run one gate to completion, inheriting stdio so colored output + progress from
 * the underlying tool reach the terminal unchanged.
 * @param {Gate} gate
 * @returns {number} the child process exit code (non-zero = failure)
 */
function runGate(gate: {
  name: string
  describe: string
  command: string[]
}): number {
  const [bin, ...args] = gate.command
  process.stdout.write(
    `\n${BOLD}▶ ${gate.name}${RESET} ${DIM}— ${gate.describe}${RESET}\n`,
  )
  const result = spawnSync(bin, args, { stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(
      `${RED}gate "${gate.name}" failed to spawn: ${result.error.message}${RESET}\n`,
    )
    return 1
  }
  // A signal-terminated child reports `status: null`; treat that as a failure.
  return result.status ?? 1
}

/**
 * Check for @ts-expect-error usage. The discipline rule requires @ts-expect-error
 * with a reason instead.
 * @returns {number} 0 if clean, 1 if violations found
 */
function checkDiscipline(): number {
  const srcDir = join(process.cwd(), 'src')
  const violations: string[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const fileStat = statSync(fullPath)
      if (fileStat.isDirectory()) {
        walk(fullPath)
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
        const content = readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('// @ts-ignore')) {
            violations.push(
              `${fullPath}:${i + 1}: @ts-ignore found — use @ts-expect-error with a reason`,
            )
          }
        }
      }
    }
  }

  try {
    walk(srcDir)
  } catch {
    // src/ doesn't exist yet, that's fine
    return 0
  }

  if (violations.length > 0) {
    process.stderr.write(
      `\n${RED}✗ gate "discipline" failed — ${violations.length} violation(s):\n${RESET}`,
    )
    for (const v of violations) {
      process.stderr.write(`  ${v}\n`)
    }
    process.stderr.write(
      `${RED}Replace @ts-ignore with @ts-expect-error and add a reason.${RESET}\n`,
    )
    return 1
  }

  return 0
}

/** @type {{ name: string; describe: string; command: string[] }[]} */
const GATES = [
  {
    name: 'format',
    describe: 'biome format (style consistency)',
    command: ['bun', 'run', 'format'],
  },
  {
    name: 'lint',
    describe: 'biome lint (rules + GritQL plugins)',
    command: ['bun', 'run', 'lint'],
  },
  {
    // Must run before typecheck: the integration tests import the package by
    // name ('zqlite'), which resolves through the exports map to ./dist. Without
    // a prior build, dist is absent (fresh checkout) or stale, and the typecheck
    // fails on those files. Building first makes the typecheck build-independent.
    name: 'build',
    describe: 'compile dist (required before the dist-consuming typecheck)',
    command: ['bun', 'run', 'build'],
  },
  {
    name: 'typecheck',
    describe: 'TypeScript typecheck all packages',
    command: ['bun', 'tsc', '--noEmit'],
  },
  {
    name: 'test',
    describe: 'bun test (full suite)',
    command: ['bun', 'test'],
  },
]

let failed: {
  gate: { name: string; describe: string; command: string[] }
  code: number
} | null = null

// Run the discipline check first (fast, no child process overhead)
const disciplineCode = checkDiscipline()
if (disciplineCode !== 0) {
  failed = {
    gate: {
      name: 'discipline',
      describe: 'check for @ts-ignore usage',
      command: [],
    },
    code: disciplineCode,
  }
}

// Run remaining gates in order
if (!failed) {
  for (const gate of GATES) {
    const code = runGate(gate)
    if (code !== 0) {
      failed = { gate, code }
      break
    }
  }
}

if (failed) {
  process.stdout.write(
    `\n${RED}✗ gate "${failed.gate.name}" failed (exit ${failed.code}).${RESET}\n`,
  )
  process.exit(failed.code)
}

process.stdout.write(`\n${GREEN}✓ All gates passed.${RESET}\n`)

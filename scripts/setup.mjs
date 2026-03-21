#!/usr/bin/env node
/**
 * setup.mjs — One-command setup for AKP.
 *
 * Installs deps, builds TypeScript, builds the UI, and initializes the node
 * identity if one doesn't exist yet.
 *
 * Usage: npm run setup
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

function run(label, cmd, cwd = ROOT) {
  process.stdout.write(`  ${label}... `)
  try {
    execSync(cmd, { cwd, stdio: 'pipe' })
    console.log('✓')
  } catch (err) {
    console.log('✗')
    console.error(`\nFailed: ${cmd}`)
    console.error(err.stderr?.toString() ?? err.message)
    process.exit(1)
  }
}

// ── Node version check ────────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number)
if (major < 18) {
  console.error(`Node.js 18+ required (found ${process.version})`)
  process.exit(1)
}

console.log('\n  AKP Setup\n  ' + '─'.repeat(40))

// ── Backend ───────────────────────────────────────────────────────────────────
run('Installing backend dependencies', 'npm install --prefer-offline')
run('Building TypeScript', 'npm run build')

// ── UI ────────────────────────────────────────────────────────────────────────
const uiDir = join(ROOT, 'ui')
if (existsSync(uiDir)) {
  run('Installing UI dependencies', 'npm install --prefer-offline', uiDir)
  run('Building UI', 'npm run build', uiDir)
} else {
  console.log('  UI directory not found — skipping UI build')
}

// ── Identity ──────────────────────────────────────────────────────────────────
const configDir = process.env.AKP_DIR ?? join(homedir(), '.akp')
const identityPath = join(configDir, 'identity.json')

if (existsSync(identityPath)) {
  console.log('  Identity already exists ✓')
} else {
  mkdirSync(configDir, { recursive: true })
  run('Generating node identity', `node dist/cli/akp.js init --dir "${configDir}"`)
}

// ── Done ──────────────────────────────────────────────────────────────────────
console.log('\n  ' + '─'.repeat(40))
console.log('  Setup complete!\n')
console.log('  Start the node:')
console.log('    npm start\n')
console.log('  Then open:')
console.log('    http://localhost:3000  (UI + API)')
console.log('    http://localhost:3000/rpc  (JSON-RPC)\n')
console.log('  Set AKP_API_KEY to require auth:')
console.log('    AKP_API_KEY=secret npm start\n')

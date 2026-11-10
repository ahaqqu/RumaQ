#!/usr/bin/env node
// Boots the plugin-built Worker bundle in the SAME workerd runtime the nightly
// Docker/automation harness uses, and asserts GET /api/health (ahaqqu/RumaQ#534).
//
// Why a second boot when `vp preview backend` already boots the bundle: the
// plugin ships a NEWER workerd than the repo's pinned `miniflare` dev
// dependency, and the two disagree on global-scope restrictions. `new
// AbortController()` at module scope — the exact #533 break — is rejected by
// the pinned workerd (the one automation/tests/support/worker-server.mjs boots
// in the nightly stack) but accepted by the plugin's newer one. A gate that
// only ran the plugin runtime would stay green on that line while the nightly
// went red again, which is precisely the failure #534 exists to stop. The
// plugin runtime still gets its own boot (deploy/preview fidelity); this one
// keeps the gate load-bearing for the nightly harness.
//
// No secrets, no D1 migrations, no Docker: /api/health is a static JSON handler
// and the runtime evaluates the whole bundle at startup, which is what fails on
// a module-scope forbidden call.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Miniflare } from 'miniflare'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Vite build output (Workers Build Output Specification): the plugin writes the
// bundled worker to workers/default/bundle under the versioned output root.
const OUTPUT_DIR = resolve(ROOT_DIR, 'backend/.cloudflare/output/v0/workers/default')
const BUNDLE_DIR = resolve(OUTPUT_DIR, 'bundle')

function collectJsModules(dir) {
  const modules = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) modules.push(...collectJsModules(path))
    else if (entry.isFile() && extname(entry.name) === '.js') {
      modules.push({ type: 'ESModule', path, contents: readFileSync(path, 'utf-8') })
    }
  }
  return modules
}

let modules
try {
  modules = collectJsModules(BUNDLE_DIR)
} catch {
  console.error(`  ✗  no Worker bundle at ${BUNDLE_DIR} — run \`vp build backend\` first`)
  process.exit(1)
}
// The entry must be first in the modules array.
const entryIndex = modules.findIndex((module) => module.path.endsWith('/index.js'))
if (entryIndex > 0) modules.unshift(...modules.splice(entryIndex, 1))

// Compatibility settings are read from the build output, so this harness never
// drifts from cloudflare.config.ts.
const workerConfig = JSON.parse(readFileSync(resolve(OUTPUT_DIR, 'worker.config.json'), 'utf-8'))

const mf = new Miniflare({
  modules,
  modulesRoot: BUNDLE_DIR,
  compatibilityDate: workerConfig.compatibilityDate,
  compatibilityFlags: workerConfig.compatibilityFlags,
})

try {
  const response = await mf.dispatchFetch('http://localhost/api/health')
  const body = await response.text()
  if (response.status !== 200 || !body.includes('"ok":true')) {
    console.error(
      `  ✗  GET /api/health on the nightly harness runtime: HTTP ${response.status} ${body}`
    )
    process.exitCode = 1
  } else {
    console.log(
      `  ✓  bundled Worker booted in the nightly harness runtime; GET /api/health → {"ok":true}`
    )
  }
} finally {
  await mf.dispose()
}

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
// plugin runtime still gets its own boot (preview fidelity; deploys build the
// same bundle through the same plugin); this one keeps the gate load-bearing
// for the nightly harness.
//
// No secrets, no D1 migrations, no Docker: /api/health is a static JSON handler
// and the runtime evaluates the whole bundle at startup, which is what fails on
// a module-scope forbidden call — including the shapes the static AST scan in
// backend/src/__tests__/worker-global-scope.test.ts cannot see (indirect calls,
// dependency code).

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

// Compatibility settings and the entry module come from the build output, so
// this harness never drifts from cloudflare.config.ts or the plugin's manifest.
let workerConfig
try {
  workerConfig = JSON.parse(readFileSync(resolve(OUTPUT_DIR, 'worker.config.json'), 'utf-8'))
} catch {
  console.error(`  ✗  no worker.config.json at ${OUTPUT_DIR} — run \`vp build backend\` first`)
  process.exit(1)
}
const entryName = workerConfig.manifest?.mainModule ?? 'index.js'
const entryPath = resolve(BUNDLE_DIR, entryName)
// The entry must be first in the modules array.
const entryIndex = modules.findIndex((module) => module.path === entryPath)
if (entryIndex === -1) {
  console.error(`  ✗  entry module ${entryName} not found in ${BUNDLE_DIR}`)
  process.exit(1)
}
if (entryIndex > 0) modules.unshift(...modules.splice(entryIndex, 1))

const BOOT_TIMEOUT_MS = 60_000
const mf = new Miniflare({
  modules,
  modulesRoot: BUNDLE_DIR,
  compatibilityDate: workerConfig.compatibilityDate,
  compatibilityFlags: workerConfig.compatibilityFlags,
})

let timedOut = false
let bootFailed = false
let timeoutId
const deadline = new Promise((_, reject) => {
  timeoutId = setTimeout(() => {
    timedOut = true
    reject(new Error(`the Worker did not serve /api/health within ${BOOT_TIMEOUT_MS / 1000}s`))
  }, BOOT_TIMEOUT_MS)
})

try {
  const { response, body } = await Promise.race([
    (async () => {
      const response = await mf.dispatchFetch('http://localhost/api/health')
      return { response, body: await response.text() }
    })(),
    deadline,
  ])
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
} catch (error) {
  bootFailed = true
  if (timedOut) console.error(`  ✗  ${error instanceof Error ? error.message : String(error)}`)
  else console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(timeoutId)
  try {
    await mf.dispose()
  } catch (error) {
    // When the boot already failed, dispose fails for the same reason and
    // must not bury the real startup error under a secondary one.
    if (!bootFailed) {
      console.error('  ✗  failed to dispose the Miniflare runtime:', error)
      process.exitCode = 1
    }
  }
}

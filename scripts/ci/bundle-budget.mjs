#!/usr/bin/env node
// Bundle-size budget gate (phase 09). Fails CI when the built frontend
// JavaScript exceeds the budget. Run after `vp build frontend`.
//
//   node scripts/ci/bundle-budget.mjs [budget-kb]
//
// Budget: 250 KB gzipped for all JS shipped in frontend/dist/assets. The
// 2026-10 baseline is ~185 KB; headroom covers feature growth before the
// budget must be revisited (lazy-load or split heavy deps first).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'

const DIST_ASSETS = resolve(process.argv[2] ?? 'frontend/dist/assets')
const BUDGET_KB = Number(process.argv[3] ?? 250)

const js = readdirSync(DIST_ASSETS)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.map'))
  .map((f) => {
    const bytes = statSync(join(DIST_ASSETS, f)).size
    return { file: f, bytes, gzip: gzipSync(readFileSync(join(DIST_ASSETS, f))).length }
  })

if (js.length === 0) {
  console.error(`bundle-budget: no JS chunks found in ${DIST_ASSETS} — build first`)
  process.exit(1)
}

const totalGzip = js.reduce((sum, c) => sum + c.gzip, 0)
const totalKb = totalGzip / 1024

for (const c of [...js].sort((a, b) => b.gzip - a.gzip).slice(0, 10)) {
  console.log(`  ${(c.gzip / 1024).toFixed(1).padStart(8)} KB gz  ${c.file}`)
}
console.log(`  ${'—'.repeat(30)}`)
console.log(`  total: ${totalKb.toFixed(1)} KB gzipped / budget: ${BUDGET_KB} KB`)

if (totalKb > BUDGET_KB) {
  console.error(
    `bundle-budget: FAILED — ${totalKb.toFixed(1)} KB exceeds the ${BUDGET_KB} KB budget. ` +
      'Lazy-load or split heavy dependencies before raising the budget.'
  )
  process.exit(1)
}
console.log('bundle-budget: OK')

import { describe, it, expect } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { readFileSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname, resolve, relative } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

// The frontend parity test (frontend/src/plugins/registry.test.js) imports
// plugins/manifests.ts directly — the bundles share no module graph, so that
// stays a build-time check only while the manifest module graph stays pure
// manifest DATA (§4.3): runtime imports inside plugins/ only, nothing from
// hono, storage or core internals (the hono/storage imports in types.ts are
// `import type`, erased at transform). Nothing else enforces this: a
// backend-only package fails the frontend suite loudly (it resolves only
// from backend/node_modules), but a root-hoisted dependency or a node
// builtin would import silently and start executing backend module graphs
// inside the frontend suite. This walk is the named guard — the drift fails
// here first, not someone's 2am frontend run.

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'plugins/manifests.ts'

type SourceFile = string // backend-src-relative POSIX path, e.g. 'plugins/types.ts'

// Comments first (prose quoting an import must never trip the scan), then
// drop type-only statements — they are erased at transform and load nothing.
// The clause between `type` and `from` may not contain a quote, a semicolon,
// or another import/export keyword: a `from`-less declaration (`export type
// X = string`) must not pair with a LATER import's `from` and swallow it.
// What remains is the runtime graph: every surviving import/export-from
// loads its target module whole, mixed named imports included
// (`import { KNOWN_PORT_IDS, type X } from './types.js'` runs types.ts).
function runtimeImportSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const runtime = code.replace(
    /\b(?:import|export)\s+type\b(?![^;'"]*\b(?:import|export|require)\b)[^;'"]*?\bfrom\s*['"][^'"]+['"]\s*;?/g,
    ''
  )
  const found = new Set<string>()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // static + export-from imports
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import()
    /\bimport\s*['"]([^'"]+)['"]/g, // bare side-effect imports
    // require() never runs in a Worker, but esbuild bundles it — and the
    // frontend suite would too, so the wall sees it.
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of runtime.matchAll(pattern)) {
      found.add(match[1])
    }
  }
  return [...found]
}

// Resolve a relative specifier to a backend-src-relative path with a .ts
// extension (the codebase's ESM specifiers use .js, which TS maps to .ts).
// Bare specifiers (packages, node: builtins) return null — a violation below.
function resolveSpecifier(fromFile: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(join(BACKEND_SRC, fromFile)), specifier)
  const rel = relative(BACKEND_SRC, target).split('\\').join('/')
  return rel.endsWith('.js') ? `${rel.slice(0, -3)}.ts` : rel
}

export type PurityViolation = string

// Walks the runtime import graph the parity test pulls in, starting at its
// entry module. Pure over its inputs so the guard can prove it fires (same
// discipline as the boundary wall). Returns the visited graph — so the
// shipped-tree test can prove the walk is not vacuous — plus one violation
// per runtime import that leaves plugins/.
function purityWalk(read: (file: SourceFile) => string): {
  graph: SourceFile[]
  violations: PurityViolation[]
} {
  const graph: SourceFile[] = []
  const violations: PurityViolation[] = []
  const visited = new Set<SourceFile>()
  const walk = (file: SourceFile) => {
    if (visited.has(file)) return
    visited.add(file)
    graph.push(file)
    for (const specifier of runtimeImportSpecifiers(read(file))) {
      const target = resolveSpecifier(file, specifier)
      if (target === null || !target.startsWith('plugins/')) {
        violations.push(
          `${file} imports '${specifier}' at runtime — the manifest module graph must stay pure plugins/ data (the frontend parity test imports it directly, so anything else executes backend code inside the frontend suite). Move it behind \`import type\` or relax this guard only by deliberate review.`
        )
        continue
      }
      walk(target)
    }
  }
  walk(ENTRY)
  return { graph, violations }
}

const realRead = (file: SourceFile) => readFileSync(join(BACKEND_SRC, file), 'utf8')

describe('manifest module purity (the frontend parity test imports manifests.ts)', () => {
  it('keeps the runtime import graph of plugins/manifests.ts inside plugins/', () => {
    const { graph, violations } = purityWalk(realRead)
    // Not vacuous: the walk must have followed the imports into the
    // documents manifest and the shared types module — a future edit that
    // grows the graph makes this pin a reviewed test change, not silent
    // drift.
    expect(graph).toEqual([
      'plugins/manifests.ts',
      'plugins/documents/manifest.ts',
      'plugins/core-prefixes.ts',
      'plugins/types.ts',
    ])
    expect(violations).toEqual([])
  })

  it('the checker itself fires when a runtime import leaves plugins/', () => {
    const { violations } = purityWalk((file) =>
      file === ENTRY
        ? [
            "import { documentsManifest } from './documents/manifest.js'",
            "import { KNOWN_PORT_IDS, type PluginManifest } from './types.js'",
            // Erased at transform — must NOT fire.
            "import type { Hono } from 'hono'",
            // A from-less type declaration: must not pair with a later
            // import's `from` and swallow it into the strip.
            'export type Probe = string',
            // Root-hoisted package, node builtin, core internal: all three
            // would run inside the frontend suite silently.
            "import { z } from 'zod'",
            "import { readFileSync } from 'node:fs'",
            "import { env } from '../env.js'",
          ].join('\n')
        : ''
    )
    expect(violations).toHaveLength(3)
    expect(violations.some((v) => v.startsWith("plugins/manifests.ts imports 'zod'"))).toBe(true)
    expect(violations.some((v) => v.startsWith("plugins/manifests.ts imports 'node:fs'"))).toBe(
      true
    )
    expect(violations.some((v) => v.startsWith("plugins/manifests.ts imports '../env.js'"))).toBe(
      true
    )
  })
})

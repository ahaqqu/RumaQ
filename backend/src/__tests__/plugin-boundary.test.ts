import { describe, it, expect } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname, relative, resolve } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

// The import boundary (ahaqqu/RumaQ#435 — plugin architecture §4.1/§4.4).
// Workers give no runtime database ACL, so the plugin wall is enforced as a
// test-time check instead — honest about the platform. The one-sentence rule
// (§4.1): a plugin may import core's published API, its own module, and
// env.DB — nothing else.
//
// The allow-list ships EMPTY in ticket 1: enforcement exists BEFORE the move
// it polices, so ticket 4's vault re-home is reviewed against a rule, not by
// eye. An entry lands only by deliberate, reviewed decision.
const ALLOWED_CORE_IMPORTS: readonly string[] = []

// The declared core→plugin composition surfaces (§2: "core calls plugins
// only via declared surfaces"). Both live INSIDE plugins/ as root modules;
// every other file — core or plugin — must reach plugin-owned modules
// through them.
const CORE_PLUGIN_COMPOSITION_ROOTS = ['plugins/manifests.ts', 'plugins/registry.ts']

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

type SourceFile = string // backend-src-relative POSIX path, e.g. 'plugins/types.ts'

function listSourceFiles(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(
    (entry: { name: string; isDirectory: () => boolean }) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') return [] // tests import everything, by design
        return listSourceFiles(full)
      }
      // esbuild bundles plain .js/.mjs/.cjs alongside .ts — the wall must see
      // every file that could end up in the Worker bundle.
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return []
      return [relative(BACKEND_SRC, full).split('\\').join('/')]
    }
  )
}

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // static + type-only imports
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import()
  /^\s*import\s+['"]([^'"]+)['"]/gm, // bare side-effect imports
  // require() never runs in a Worker, but esbuild BUNDLES it — a plugin that
  // requires core internals would still ship the violation, so the wall sees it.
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function importSpecifiers(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1])
    }
  }
  return [...found]
}

// Resolve a relative specifier to a backend-src-relative path with a .ts
// extension (the codebase's ESM specifiers use .js, which TS maps to .ts).
function resolveSpecifier(fromFile: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null // external package — outside the boundary
  const target = resolve(dirname(join(BACKEND_SRC, fromFile)), specifier)
  const rel = relative(BACKEND_SRC, target).split('\\').join('/')
  return rel.endsWith('.js') ? `${rel.slice(0, -3)}.ts` : rel
}

type ImportKind = 'external' | 'plugin-root' | 'plugin-owned' | 'core-internal'

type ClassifiedImport = {
  kind: ImportKind
  target: string
  specifier: string
  pluginId?: string
}

function pluginIdOf(file: SourceFile): string | undefined {
  const match = /^plugins\/([^/]+)\/.+/.exec(file)
  return match?.[1]
}

function classify(fromFile: SourceFile, specifier: string): ClassifiedImport {
  const target = resolveSpecifier(fromFile, specifier)
  if (target === null) return { kind: 'external', target: specifier, specifier }
  const segments = target.split('/')
  if (segments[0] === 'plugins') {
    if (segments.length === 2) return { kind: 'plugin-root', target, specifier }
    return { kind: 'plugin-owned', target, specifier, pluginId: segments[1] }
  }
  return { kind: 'core-internal', target, specifier }
}

export type BoundaryViolation = string

// Pure over its inputs so the rules themselves are testable — the shipped
// tree must pass AND each rule must demonstrably fire (a checker that
// silently stops matching is worse than no checker).
function findBoundaryViolations(
  files: SourceFile[],
  read: (file: SourceFile) => string
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []
  for (const file of files) {
    const owner = pluginIdOf(file)
    const compositionRoot = CORE_PLUGIN_COMPOSITION_ROOTS.includes(file)
    for (const specifier of importSpecifiers(read(file))) {
      const info = classify(file, specifier)
      if (owner) {
        // Rule 1 — plugin → core: published API (plugin-root modules) only;
        // core internals need the (empty) allow-list. Rule 2 — no sibling
        // plugins (§2: plugins never import another plugin).
        if (info.kind === 'core-internal' && !ALLOWED_CORE_IMPORTS.includes(info.target)) {
          violations.push(
            `${file} imports core internal ${info.target} ('${specifier}') — plugins import core's published API only (plan §4.1); add to ALLOWED_CORE_IMPORTS only by deliberate review`
          )
        }
        if (info.kind === 'plugin-owned' && info.pluginId !== owner) {
          violations.push(
            `${file} imports another plugin's module ${info.target} — plugins never import sibling plugins (plan §2)`
          )
        }
      } else if (!compositionRoot && info.kind === 'plugin-owned') {
        // Rule 3 — core → plugins only through the declared surfaces.
        violations.push(
          `${file} imports plugin-owned ${info.target} ('${specifier}') — core calls plugins only via ${CORE_PLUGIN_COMPOSITION_ROOTS.join(' / ')} (plan §2)`
        )
      }
    }
  }
  return violations
}

const realRead = (file: SourceFile) => readFileSync(join(BACKEND_SRC, file), 'utf8')

describe('plugin import boundary (#435)', () => {
  it('ships an EMPTY allow-list — ticket 4 is policed from the first line it moves', () => {
    expect(ALLOWED_CORE_IMPORTS).toEqual([])
  })

  it('every backend source file passes the boundary rules', () => {
    const files = listSourceFiles(BACKEND_SRC)
    expect(files.length).toBeGreaterThan(10)
    expect(findBoundaryViolations(files, realRead)).toEqual([])
  })

  it('the gateway dispatches through the registry seam (the one declared surface)', () => {
    const specifiers = importSpecifiers(realRead('gateway.ts'))
    expect(specifiers).toContain('./plugins/registry.js')
    expect(specifiers).not.toContain('./apps/documents.js')
  })

  it('the checker itself fires on every rule (a deaf checker is worse than none)', () => {
    const synthetic: Record<SourceFile, string> = {
      'plugins/documents/app.ts': [
        "import { helper } from '../../lib/should-not-reach.js'",
        "import { otherPluginThing } from '../other/thing.js'",
        "import { propsAuthMiddleware } from '../../auth.js'",
      ].join('\n'),
      // require() + a non-.ts file: both would be invisible to a from-only,
      // .ts-only scan (PL1-B4) — the checker must fire on them too.
      'plugins/documents/legacy.js': "const x = require('../../lib/should-not-reach.js')",
      'apps/api.ts': "import { documentsManifest } from '../plugins/documents/manifest.js'\n",
      'plugins/gate.ts': "import { something } from './documents/manifest.js'\n",
      'plugins/documents/clean.ts': [
        "import type { PluginManifest } from '../types.js'",
        "import { Hono } from 'hono'",
      ].join('\n'),
    }
    const violations = findBoundaryViolations(Object.keys(synthetic), (file) => synthetic[file])
    expect(
      violations.some((v) =>
        v.startsWith('plugins/documents/app.ts imports core internal lib/should-not-reach.ts')
      )
    ).toBe(true)
    expect(
      violations.some((v) => v.startsWith('plugins/documents/app.ts imports core internal auth.ts'))
    ).toBe(true)
    expect(
      violations.some((v) => v.startsWith('plugins/documents/app.ts imports another plugin'))
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.startsWith('plugins/documents/legacy.js imports core internal lib/should-not-reach')
      )
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.startsWith('apps/api.ts imports plugin-owned plugins/documents/manifest.ts')
      )
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.startsWith('plugins/gate.ts imports plugin-owned plugins/documents/manifest.ts')
      )
    ).toBe(true)
    // The clean file raises nothing: published API + externals are allowed.
    expect(violations.some((v) => v.startsWith('plugins/documents/clean.ts'))).toBe(false)
  })
})

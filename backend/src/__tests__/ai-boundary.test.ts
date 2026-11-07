import { describe, it, expect } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname, relative, resolve } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'

// THE AI BOUNDARY (ahaqqu/RumaQ#523 P2, plan §2.3). The one-door rule is a
// security control, not a style rule: a capability assignment is only
// meaningful if nothing bypasses it, and platform-funded AI can only be metered
// if exactly one module dispatches provider requests. Workers give no runtime
// ACL for that, so it is enforced here (the plugin-boundary.test.ts precedent).
//
// Outside `backend/src/lib/ai/**` — the door — a module may build prompts,
// validate a model's answer, write usage rows and map `AiError` to HTTP. It may
// NOT import an adapter, import the key-material module, contain a provider
// hostname, or read a provider key (`.apiKey`).
//
// Two PINNED legacy exemptions exist for P2 only, and the test asserts their
// exact contents so a new violation cannot be added silently:
//   - `apps/api.ts` still probes five vendor endpoints for the legacy
//     `POST /api/ai-key/test`; P3 deletes that route and the hostnames with it.
//   - the P1 bridge (`lib/ai-access.ts`) and its three consumers forward
//     `access.apiKey` to the deprecated shim; P4 deletes the shim and the
//     bridge, so this list must become empty. Neither P2 nor P3 may grow it.

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

// The door itself. The DEPRECATED shim (lib/ai.ts) and bridge (lib/ai-access.ts)
// live one level up and are covered by the pinned lists below.
const DOOR_DIR = 'lib/ai/'

type SourceFile = string // backend-src-relative POSIX path, e.g. 'apps/api.ts'

// The vendor endpoints the door's presets/adapters own. A literal one anywhere
// else is provider transport that escaped.
const PROVIDER_HOSTNAME =
  /api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.openai\.com|ollama\.com|api\.opencode\.ai|api\.typesafe\.ai/

// The property that only the door may read (the key material).
const KEY_MATERIAL = /\.apiKey\b/

// P3 deletes `POST /api/ai-key/test`, the last transport outside the door.
const LEGACY_HOSTNAME_EXEMPTIONS: readonly SourceFile[] = ['apps/api.ts']

// P4 deletes the shim + bridge; until then the legacy shape still carries a key.
const LEGACY_KEY_EXEMPTIONS: readonly SourceFile[] = [
  'apps/api.ts',
  'lib/ai-access.ts',
  'lib/document-ocr.ts',
  'lib/review-ai.ts',
]

// Only the two deprecated shims may reach the door-internal legacy bridge; a
// third importer would be new coupling to code that is being deleted.
const LEGACY_BRIDGE_IMPORTERS: readonly SourceFile[] = ['lib/ai-access.ts', 'lib/ai.ts']

function listSourceFiles(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(
    (entry: { name: string; isDirectory: () => boolean }) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') return [] // tests reach into the door by design
        return listSourceFiles(full)
      }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return []
      return [relative(BACKEND_SRC, full).split('\\').join('/')]
    }
  )
}

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // static + type-only imports
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import()
  /^\s*import\s+['"]([^'"]+)['"]/gm, // bare side-effect imports
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function importSpecifiers(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/** Resolve a relative specifier to a backend-src-relative .ts path. */
function resolveSpecifier(fromFile: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null // external package — outside the boundary
  const target = resolve(dirname(join(BACKEND_SRC, fromFile)), specifier)
  const rel = relative(BACKEND_SRC, target).split('\\').join('/')
  return rel.endsWith('.js') ? `${rel.slice(0, -3)}.ts` : rel
}

export type BoundaryViolation = string

// Pure over its inputs, so each rule can demonstrably fire on a synthetic file
// (a checker that silently stops matching is worse than no checker).
export function findAiBoundaryViolations(
  files: SourceFile[],
  read: (file: SourceFile) => string
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []

  for (const file of files) {
    const source = read(file)
    const insideDoor = file.startsWith(DOOR_DIR)

    for (const specifier of importSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier)
      if (target === null || insideDoor) continue

      // Rule 1 — adapters are composition inside the door only.
      if (target.startsWith(`${DOOR_DIR}adapters/`)) {
        violations.push(
          `${file} imports the AI adapter ${target} ('${specifier}') — provider transport lives inside lib/ai/** only (plan §2.3)`
        )
      }
      // Rule 2 — the key-material module is never imported from outside.
      if (target === `${DOOR_DIR}credentials.ts`) {
        violations.push(
          `${file} imports ${target} ('${specifier}') — the decrypted key may only exist inside lib/ai/** (plan §2.3/D10)`
        )
      }
      // Rule 3 — the deprecated legacy bridge has exactly two importers.
      if (target === `${DOOR_DIR}legacy.ts` && !LEGACY_BRIDGE_IMPORTERS.includes(file)) {
        violations.push(
          `${file} imports the deprecated AI legacy bridge ${target} ('${specifier}') — only lib/ai.ts and lib/ai-access.ts may, and both are deleted in P4`
        )
      }
    }

    if (insideDoor) continue

    // Rule 4 — no provider endpoint literal outside the door.
    if (PROVIDER_HOSTNAME.test(source) && !LEGACY_HOSTNAME_EXEMPTIONS.includes(file)) {
      violations.push(
        `${file} contains a provider hostname — model endpoints are reached through lib/ai/** only (plan §2.3)`
      )
    }
    // Rule 5 — no module outside the door reads a provider key.
    if (KEY_MATERIAL.test(source) && !LEGACY_KEY_EXEMPTIONS.includes(file)) {
      violations.push(
        `${file} reads .apiKey — a provider key never leaves lib/ai/** (plan §2.3/D10); the P2 exemption list may only shrink`
      )
    }
  }

  return violations
}

const realRead = (file: SourceFile) => readFileSync(join(BACKEND_SRC, file), 'utf8')

describe('AI boundary — the one door (#523 P2, plan §2.3)', () => {
  it('the exemptions are exactly the pinned legacy set (P3/P4 must shrink them to empty)', () => {
    // The hostname exemption is the P3-doomed `/api/ai-key/test` probe.
    expect([...LEGACY_HOSTNAME_EXEMPTIONS].sort()).toEqual(['apps/api.ts'])
    // The key exemption is the P1 bridge plus the routes that forward its key
    // to the deprecated shim. Adding a file here is a boundary change.
    expect([...LEGACY_KEY_EXEMPTIONS].sort()).toEqual(
      ['apps/api.ts', 'lib/ai-access.ts', 'lib/document-ocr.ts', 'lib/review-ai.ts'].sort()
    )
    // The deprecated legacy bridge has exactly two importers.
    expect([...LEGACY_BRIDGE_IMPORTERS].sort()).toEqual(['lib/ai-access.ts', 'lib/ai.ts'])
  })

  it('every backend source file outside the door passes the boundary rules', () => {
    const files = listSourceFiles(BACKEND_SRC)
    expect(files.length).toBeGreaterThan(10)
    expect(findAiBoundaryViolations(files, realRead)).toEqual([])
  })

  it('the deprecated shims contain no transport of their own', () => {
    // lib/ai.ts is a THIN shim (plan §6 P2): it forwards messages and usage, it
    // neither fetches nor holds an endpoint. Same for the bridge.
    for (const file of ['lib/ai.ts', 'lib/ai-access.ts']) {
      const source = realRead(file)
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(PROVIDER_HOSTNAME)
    }
  })

  it('the checker itself fires on every rule (a deaf checker is worse than none)', () => {
    const synthetic: Record<SourceFile, string> = {
      'lib/rogue-adapter.ts': "import { openaiAdapter } from './ai/adapters/openai.js'\n",
      'lib/rogue-key.ts': "import { decryptProviderKey } from './ai/credentials.js'\n",
      'lib/rogue-legacy.ts': "import { legacyCompleteText } from './ai/legacy.js'\n",
      'lib/rogue-endpoint.ts': "const url = 'https://api.openai.com/v1/chat/completions'\n",
      'lib/rogue-key-read.ts': 'const key = access.apiKey\n',
      // Allowed shapes: the door itself, the door's public facade, and the two
      // pinned legacy shims reaching the bridge.
      'lib/ai/adapters/openai.ts': "const url = 'https://api.openai.com/v1'\n",
      'lib/ai/ok.ts': "import { adapterFor } from './adapters/registry.js'\n",
      'lib/ai.ts': "import { legacyCompleteText } from './ai/legacy.js'\n",
      'lib/ai-access.ts': "import { resolveLegacyAccess } from './ai/legacy.js'\n",
      'lib/feature.ts': "import { completeText } from './ai/index.js'\n",
    }
    const read = (file: SourceFile) => synthetic[file]
    const violations = findAiBoundaryViolations(Object.keys(synthetic), read)

    expect(
      violations.some((v) => v.startsWith('lib/rogue-adapter.ts imports the AI adapter'))
    ).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/rogue-key.ts imports'))).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/rogue-legacy.ts imports'))).toBe(true)
    expect(
      violations.some((v) => v.startsWith('lib/rogue-endpoint.ts contains a provider hostname'))
    ).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/rogue-key-read.ts reads .apiKey'))).toBe(true)

    // Nothing else fires: the door owns transport, the facade is importable,
    // the pinned shims may reach the bridge.
    for (const clean of [
      'lib/ai/adapters/openai.ts',
      'lib/ai/ok.ts',
      'lib/ai.ts',
      'lib/ai-access.ts',
      'lib/feature.ts',
    ]) {
      expect(violations.some((v) => v.startsWith(clean))).toBe(false)
    }
  })
})

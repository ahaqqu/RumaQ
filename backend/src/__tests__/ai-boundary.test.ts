import { describe, it, expect } from 'vite-plus/test'
import * as door from '../lib/ai/index.js'
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
// THERE ARE NO EXEMPTIONS (#523 P4). The P2/P3 pinned lists existed only while
// the deprecated shim (`lib/ai.ts`), the P1 bridge (`lib/ai-access.ts`) and the
// door-internal `lib/ai/legacy.ts` were waiting to be deleted; P4 deleted all
// three, so every rule below now holds over the WHOLE tree with no allow-list.
// The `lib/ai.ts` / `lib/ai-access.ts` / `lib/ai/legacy.ts` absence is asserted
// too: a re-introduced shim must fail here before it can grow a caller.

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

// The door itself. The DEPRECATED shim (lib/ai.ts) and bridge (lib/ai-access.ts)
// live one level up and are covered by the pinned lists below.
const DOOR_DIR = 'lib/ai/'

type SourceFile = string // backend-src-relative POSIX path, e.g. 'apps/api.ts'

// The vendor endpoints the door's presets/adapters own. A literal one anywhere
// else is provider transport that escaped.
const PROVIDER_HOSTNAME =
  /api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.openai\.com|ollama\.com|api\.opencode\.ai|openrouter\.ai/

// The property that only the door may read (the key material).
const KEY_MATERIAL = /\.apiKey\b/

// The door-internal modules that hand out or read key material. BOTH are
// import-banned outside the door: `credentials.ts` decrypts a stored envelope,
// `key-material.ts` returns the decrypted key for a handle. Blocking only the
// first left `accessMaterial(handle)?.apiKey` (or a destructuring of it, which
// the `.apiKey` text rule cannot see) reachable from a feature, because
// `capabilities.ts` is legitimately importable outside the door.
const KEY_MATERIAL_MODULES: readonly SourceFile[] = [
  `${DOOR_DIR}credentials.ts`,
  `${DOOR_DIR}key-material.ts`,
]

// The files P4 deleted. Nothing outside the door may reach them, and nothing
// may bring them back: these are the names the boundary used to pin instead.
const RETIRED_LEGACY_FILES: readonly SourceFile[] = [
  'lib/ai.ts',
  'lib/ai-access.ts',
  `${DOOR_DIR}legacy.ts`,
]

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

/**
 * Every module path a relative specifier can denote. TypeScript source imports
 * carry `.js`, but extensionless specifiers (`'./key-material'`) are equally
 * real to the bundler — a resolver that only understood `.js` let an
 * extensionless import of the key-material module through (delta review #3).
 */
function resolveCandidates(fromFile: SourceFile, specifier: string): SourceFile[] {
  if (!specifier.startsWith('.')) return [] // external package — outside the boundary
  const target = resolve(dirname(join(BACKEND_SRC, fromFile)), specifier)
  const rel = relative(BACKEND_SRC, target).split('\\').join('/')
  const candidates = new Set<string>([rel])
  if (rel.endsWith('.js')) {
    candidates.add(`${rel.slice(0, -3)}.ts`)
  } else if (!/\.[cm]?[jt]sx?$/.test(rel)) {
    // Extensionless: a file, or a directory index.
    candidates.add(`${rel}.ts`)
    candidates.add(`${rel}.tsx`)
    candidates.add(`${rel}/index.ts`)
  }
  return [...candidates]
}

const EXPORT_FROM =
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g

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
      const targets = resolveCandidates(file, specifier)
      if (targets.length === 0 || insideDoor) continue

      // Rule 1 — adapters are composition inside the door only.
      const adapter = targets.find((target) => target.startsWith(`${DOOR_DIR}adapters/`))
      if (adapter) {
        violations.push(
          `${file} imports the AI adapter ${adapter} ('${specifier}') — provider transport lives inside lib/ai/** only (plan §2.3)`
        )
      }
      // Rule 2 — a key-material module is never imported from outside.
      const keyModule = targets.find((target) => KEY_MATERIAL_MODULES.includes(target))
      if (keyModule) {
        violations.push(
          `${file} imports ${keyModule} ('${specifier}') — the decrypted key may only exist inside lib/ai/** (plan §2.3/D10)`
        )
      }
    }

    if (insideDoor) {
      // Rule 6 — key material is never RE-EXPORTED, from any door module. The
      // facade (`index.ts`) is importable outside, so `export { accessMaterial }
      // from './key-material.js'` there would hand out the key while rules 2/4/5
      // stayed green (delta review #3). Import the material directly, in-module.
      for (const match of source.matchAll(EXPORT_FROM)) {
        const keyModule = resolveCandidates(file, match[1]).find((target) =>
          KEY_MATERIAL_MODULES.includes(target)
        )
        if (keyModule) {
          violations.push(
            `${file} re-exports ${keyModule} ('${match[1]}') — key material never leaves its module, not even through the facade (plan §2.3/D10)`
          )
        }
      }
      continue
    }

    // Rule 4 — no provider endpoint literal outside the door.
    if (PROVIDER_HOSTNAME.test(source)) {
      violations.push(
        `${file} contains a provider hostname — model endpoints are reached through lib/ai/** only (plan §2.3)`
      )
    }
    // Rule 5 — no module outside the door reads a provider key.
    if (KEY_MATERIAL.test(source)) {
      violations.push(
        `${file} reads .apiKey — a provider key never leaves lib/ai/** (plan §2.3/D10); there are no exemptions`
      )
    }
  }

  return violations
}

const realRead = (file: SourceFile) => readFileSync(join(BACKEND_SRC, file), 'utf8')

// The facade's VALUE surface, pinned. Type exports are erased at runtime, so
// every name here is something a feature can call. A re-export of
// `accessMaterial`/`holdMaterial` — or any new door export — must be a
// deliberate edit to this list (delta review #3).
const FACADE_EXPORTS: readonly string[] = [
  'AI_TIMEOUT_MS',
  'AiError',
  'CAPABILITIES',
  'EMPTY_USAGE',
  'THINKING_LEVELS',
  'buildAiUsageEventStatement',
  'completeText',
  'decide',
  'deleteExpiredAiUsageEvents',
  'isAiError',
  'parseJsonResponse',
  'recordAiUsageEvent',
  'resolveAccess',
  'structured',
  'vision',
]

describe('AI boundary — the one door (#523 P2, plan §2.3)', () => {
  it('the P2/P3 exemptions are GONE and the retired shims cannot come back (#523 P4)', () => {
    // The exemption lists are deleted, not merely emptied: the rules now hold
    // over the whole tree with no allow-list (the walk below proves it). A shim
    // that reappears would have to re-open the list — a deliberate, reviewable
    // edit — instead of inheriting an exemption.
    const files = listSourceFiles(BACKEND_SRC)
    for (const retired of RETIRED_LEGACY_FILES) {
      expect(files, `${retired} was deleted in P4 and must stay deleted`).not.toContain(retired)
    }
    // No source file may import a retired shim either (the import would fail to
    // resolve, but this names the rule at the boundary).
    for (const file of files) {
      const source = realRead(file)
      for (const retired of ['ai-access', 'ai/legacy']) {
        expect(source, `${file} still references the retired ${retired}`).not.toContain(retired)
      }
    }
  })

  it('the facade exports exactly its pinned value surface', () => {
    // The runtime namespace is the real export list: this is what a feature can
    // import. Anything new — especially a key-material re-export — fails here.
    expect(Object.keys(door).sort()).toEqual([...FACADE_EXPORTS].sort())
    for (const leak of ['accessMaterial', 'holdMaterial', 'decryptProviderKey']) {
      expect(Object.keys(door)).not.toContain(leak)
    }
  })

  it('every backend source file outside the door passes the boundary rules', () => {
    const files = listSourceFiles(BACKEND_SRC)
    expect(files.length).toBeGreaterThan(10)
    expect(findAiBoundaryViolations(files, realRead)).toEqual([])
  })

  it('the checker itself fires on every rule (a deaf checker is worse than none)', () => {
    const synthetic: Record<SourceFile, string> = {
      'lib/rogue-adapter.ts': "import { openaiAdapter } from './ai/adapters/openai.js'\n",
      'lib/rogue-key.ts': "import { decryptProviderKey } from './ai/credentials.js'\n",
      'lib/rogue-material.ts': "import { accessMaterial } from './ai/key-material.js'\n",
      // Same violation, extensionless specifier (delta review #3's bypass).
      'lib/rogue-material-extensionless.ts': "import { accessMaterial } from './ai/key-material'\n",
      // The facade re-exporting the material is a leak even inside the door.
      'lib/ai/index.ts': "export { accessMaterial } from './key-material.js'\n",
      'lib/ai/rogue-star.ts': "export * from './key-material.js'\n",
      'lib/rogue-endpoint.ts': "const url = 'https://api.openai.com/v1/chat/completions'\n",
      'lib/rogue-openrouter.ts': "const url = 'https://openrouter.ai/api/v1/chat/completions'\n",
      'lib/rogue-key-read.ts': 'const key = access.apiKey\n',
      // Allowed shapes: the door itself and the door's public facade.
      'lib/ai/adapters/openai.ts': "const url = 'https://api.openai.com/v1'\n",
      'lib/ai/ok.ts': "import { adapterFor } from './adapters/registry.js'\n",
      'lib/ai/capabilities.ts': "import { holdMaterial } from './key-material.js'\n",
      // An extensionless import INSIDE the door is legal — only the export is not.
      'lib/ai/rogue-import.ts': "import { accessMaterial } from './key-material'\n",
      // Extensionless imports of allowed modules must stay clean outside too.
      'lib/feature-extensionless.ts': "import { completeText } from './ai/index'\n",
      'lib/feature.ts': "import { completeText } from './ai/index.js'\n",
    }
    const read = (file: SourceFile) => synthetic[file]
    const violations = findAiBoundaryViolations(Object.keys(synthetic), read)

    expect(
      violations.some((v) => v.startsWith('lib/rogue-adapter.ts imports the AI adapter'))
    ).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/rogue-key.ts imports'))).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/rogue-material.ts imports'))).toBe(true)
    expect(
      violations.some((v) => v.startsWith('lib/rogue-material-extensionless.ts imports'))
    ).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/ai/index.ts re-exports'))).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/ai/rogue-star.ts re-exports'))).toBe(true)
    expect(
      violations.some((v) => v.startsWith('lib/rogue-endpoint.ts contains a provider hostname'))
    ).toBe(true)
    expect(
      violations.some((v) => v.startsWith('lib/rogue-openrouter.ts contains a provider hostname'))
    ).toBe(true)
    expect(violations.some((v) => v.startsWith('lib/rogue-key-read.ts reads .apiKey'))).toBe(true)

    // Nothing else fires: the door owns transport and key material, the facade
    // is importable.
    for (const clean of [
      'lib/ai/adapters/openai.ts',
      'lib/ai/ok.ts',
      'lib/ai/capabilities.ts',
      'lib/ai/rogue-import.ts',
      'lib/feature-extensionless.ts',
      'lib/feature.ts',
    ]) {
      expect(violations.some((v) => v.startsWith(clean))).toBe(false)
    }
  })
})

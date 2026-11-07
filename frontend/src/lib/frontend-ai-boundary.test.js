import { describe, it, expect } from 'vite-plus/test'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// THE FRONTEND AI BOUNDARY (ahaqqu/RumaQ#523 P5, plan §2.3).
//
// The browser may call `/api/ai/*` and nothing else. Until P5 this rule was
// aspirational: `frontend/src/lib/persona.js` held three provider clients plus a
// key-test switch and `frontend/src/lib/aiProviders.js` carried a "keep in sync"
// copy of the vendor default models, so the household's key lived in page memory
// and every persona rewrite was an unbilled, unthrottled call straight from the
// tab (plan §1.2, call sites 8 and 9).
//
// P5 deleted those clients: the rewrite is `POST /api/ai/generate/persona` and
// the key test is `POST /api/ai/providers/:id/test`. This test is what keeps them
// deleted — the same static-scan shape as the backend's `ai-boundary.test.ts`,
// because a Worker cannot hand the browser a runtime ACL and a code review is
// not a gate.
//
// Deliberately NOT scanned: `*.test.js(x)` (a fixture may name an endpoint the
// API returned — it is data, not transport) and anything under `node_modules`.
// The pure `violationsOf` export makes each rule demonstrably fire on a
// synthetic provider client, so none can silently stop matching.

const FRONTEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The vendor endpoints the door's presets own server-side. */
const PROVIDER_HOSTNAME =
  /api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.openai\.com|ollama\.com|api\.opencode\.ai|api\.typesafe\.ai/

/** A key header in browser code: the Worker is the only place a key is read. */
const KEY_HEADER = /\bAuthorization\s*:\s*[`'"]\s*Bearer|['"`]x-api-key['"`]/i

/** A hardcoded absolute URL handed to fetch: transport belongs to lib/api.ts. */
const ABSOLUTE_FETCH = /\bfetch\(\s*[`'"]https?:\/\//

/** The P3 retirements: a client may not call the retired key-test route. */
const RETIRED_ENDPOINT = '/api/ai-key/test'

/** Files P5 deleted. Bringing one back re-opens the whole class of bug. */
const RETIRED_FILES = ['lib/aiProviders.js']

/** Every shipped source file, frontend-src-relative ('lib/persona.js'). */
function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return []
      return listSourceFiles(full)
    }
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) return []
    // Tests may name a provider endpoint as DATA (the API returns `base_url`
    // and the Settings test asserts it renders); shipping code may not.
    if (/\.test\.(js|jsx|ts|tsx)$/.test(entry.name)) return []
    return [relative(FRONTEND_SRC, full).split('\\').join('/')]
  })
}

/** Every rule that fires on one source file, by name (empty = clean). */
function violationsOf(source) {
  const found = []
  if (PROVIDER_HOSTNAME.test(source)) found.push('a provider hostname')
  if (KEY_HEADER.test(source)) found.push('a provider key header')
  if (ABSOLUTE_FETCH.test(source)) found.push('fetch() to an absolute URL')
  if (source.includes(RETIRED_ENDPOINT)) found.push('the retired key-test endpoint')
  return found
}

function isCommentLine(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

describe('the frontend AI boundary (#523 P5)', () => {
  it('ships no provider hostname, key header, or absolute fetch', () => {
    const files = listSourceFiles(FRONTEND_SRC)
    // A walk that silently stops finding files would make this test vacuous
    // (the backend boundary test makes the same guard explicit).
    expect(files.length).toBeGreaterThan(40)
    expect(files).toContain('lib/persona.js')
    expect(files).toContain('lib/api.ts')

    const offenders = []
    for (const file of files) {
      const source = readFileSync(join(FRONTEND_SRC, file), 'utf8')
      // Comment lines may NAME a vendor while explaining the boundary; only
      // executable text counts. (The backend scan does not strip comments; the
      // frontend files here are prose-light, so line filtering is enough.)
      const code = source
        .split('\n')
        .filter((line) => !isCommentLine(line))
        .join('\n')
      for (const violation of violationsOf(code)) offenders.push(`${file}: ${violation}`)
    }
    expect(offenders).toEqual([])
  })

  it('would catch a provider client that came back', () => {
    // The exact shape P5 deleted from persona.js, one provider at a time.
    const synthetic = `
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        headers: { 'x-api-key': apiKey, Authorization: \`Bearer \${apiKey}\` },
      })
      export async function testAiKey(key) {
        return fetch('/api/ai-key/test', { method: 'POST', body: key })
      }
    `
    expect(violationsOf(synthetic)).toEqual([
      'a provider hostname',
      'a provider key header',
      'fetch() to an absolute URL',
      'the retired key-test endpoint',
    ])
  })

  it('keeps the deleted browser provider defaults deleted', () => {
    // aiProviders.js was the "keep in sync" duplication of the backend's vendor
    // defaults (#523 P5). The UI learns labels and endpoints from
    // GET /api/ai/presets; a local default-model table has no reader left.
    for (const file of RETIRED_FILES) {
      expect(existsSync(join(FRONTEND_SRC, file)), file).toBe(false)
    }
  })

  it('routes the persona rewrite through the API client, never a provider', () => {
    // The module that used to hold three provider clients now talks to exactly
    // one thing: the generated API client.
    const source = readFileSync(join(FRONTEND_SRC, 'lib/persona.js'), 'utf8')
    expect(source).toContain("from './api'")
    expect(source).toContain('generateAiPersonaCopy')
    expect(source).not.toMatch(/\bfetch\(/)
    expect(source).not.toMatch(/sk-/)
    expect(violationsOf(source)).toEqual([])
  })
})

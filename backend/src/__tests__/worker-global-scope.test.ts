import { describe, it, expect } from 'vite-plus/test'
// @ts-expect-error — no node types in this tsconfig
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error — no node types in this tsconfig
import { join, dirname, relative } from 'node:path'
// @ts-expect-error — no node types in this tsconfig
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

// WORKERD GLOBAL-SCOPE GUARD (ahaqqu/RumaQ#523 P2 → P3 review B2).
//
// The Worker bundle is evaluated once, at startup, inside workerd's global
// scope. That scope forbids generating random values, starting timers and doing
// IO: `new AbortController()`, `crypto.*`, `Math.random()`, `fetch()`,
// `setTimeout` and friends throw there ("generating random values are not
// allowed within global scope"), and the WHOLE Worker fails to start — every
// route included, not just the one that touched them.
//
// P2 shipped `lib/ai/legacy.ts` with a module-scope `new AbortController()`, the
// Docker stack could not come up, and nothing in the PR gate objected: Node
// permits at module scope exactly what workerd rejects, so all 1,300 unit tests
// stayed green. The only harness that noticed was the automation stack, which
// is nightly. This test is the PR-gate version of that check: a static, AST-based
// scan of every module-scope expression that runs during bundle evaluation.
//
// Scanned: the initializer of every top-level `const`/`let`/`var` (exported or
// not), every top-level expression statement, and IIFE bodies (they also run
// during evaluation). NOT scanned: ordinary function bodies (they run per call,
// where these APIs are fine), callbacks handed to a call at module scope (that
// needs a call graph), and indirect helpers called at module scope. The shapes
// that caused the outage were direct. Allowed module-scope work stays allowed:
// `new Map`, `new Set`, `new TextEncoder`, `new Hono` and `new URL` are not on
// the list.
//
// The AST comes from @babel/parser, not the TypeScript compiler API: typescript@7
// is the native compiler and only ships the CLI (`import 'typescript'` now
// resolves to a version shim), so `ts.createSourceFile` and the `ts.isX` node
// guards this test used are gone (ahaqqu/RumaQ#564).

const BACKEND_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['__tests__', 'node_modules'])

type Violation = { file: string; line: number; construct: string; snippet: string }

/** The slice of a Babel AST node this scan reads; nodes are walked by shape. */
type Node = {
  type: string
  start: number | null
  end: number | null
  [key: string]: unknown
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string'

/** Visit the direct children of a node, whatever their field or array. */
function forEachChild(node: Node, visit: (child: Node) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue
    if (isNode(value)) {
      visit(value)
      continue
    }
    if (!Array.isArray(value)) continue
    for (const item of value) if (isNode(item)) visit(item)
  }
}

const childOf = (node: Node, key: string): Node | null => {
  const value = node[key]
  return isNode(value) ? value : null
}

const childrenOf = (node: Node, key: string): Node[] => {
  const value = node[key]
  return Array.isArray(value) ? value.filter(isNode) : []
}

const nameOf = (node: Node | null): string | null => {
  if (!node) return null
  const value = node.name
  return typeof value === 'string' ? value : null
}

/** The leftmost identifier of a property chain (`a.b.c` → `a`). */
function rootIdentifier(node: Node): Node | null {
  let current: Node | null = node
  for (;;) {
    if (!current) return null
    if (current.type === 'Identifier') return current
    if (current.type === 'MemberExpression' && current.computed === false) {
      current = childOf(current, 'object')
      continue
    }
    return null
  }
}

const BANNED_CONSTRUCTORS = new Map([
  ['AbortController', 'new AbortController()'],
  ['Request', 'new Request()'],
])

const BANNED_CALLS = ['fetch', 'setTimeout', 'setInterval', 'queueMicrotask']

/** The banned construct this node is, or null. */
function bannedConstruct(node: Node): string | null {
  if (node.type === 'NewExpression') {
    const callee = childOf(node, 'callee')
    const name = callee?.type === 'Identifier' ? nameOf(callee) : null
    return name ? (BANNED_CONSTRUCTORS.get(name) ?? null) : null
  }
  if (node.type !== 'CallExpression') return null
  const callee = childOf(node, 'callee')
  if (!callee) return null
  if (callee.type === 'Identifier') {
    const name = nameOf(callee)
    return name && BANNED_CALLS.includes(name) ? `${name}()` : null
  }
  if (callee.type !== 'MemberExpression' || callee.computed !== false) return null
  const owner = rootIdentifier(callee)
  const name = nameOf(childOf(callee, 'property'))
  if (!owner || !name) return null
  const ownerName = nameOf(owner)
  if (ownerName === 'AbortSignal' && ['timeout', 'any'].includes(name)) {
    return `AbortSignal.${name}()`
  }
  if (ownerName === 'Math' && name === 'random') return 'Math.random()'
  if (ownerName === 'performance' && name === 'now') return 'performance.now()'
  if (ownerName === 'crypto') return 'crypto.*'
  return null
}

// A function VALUE does not run during evaluation — its body is per-call. Class
// and object methods are function values too, however Babel names them.
const FUNCTION_LIKE = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
])

const isFunctionLike = (node: Node): boolean => FUNCTION_LIKE.has(node.type)

type Report = (node: Node, construct: string) => void

function walkEvaluated(node: Node, report: Report): void {
  const banned = bannedConstruct(node)
  if (banned) {
    report(node, banned)
    return
  }
  // (An IIFE is entered by `scanEvaluated`, never through this branch.)
  if (isFunctionLike(node)) return
  forEachChild(node, (child) => walkEvaluated(child, report))
}

/** Scan an expression that runs during module evaluation, including IIFEs. */
function scanEvaluated(node: Node, report: Report): void {
  const banned = bannedConstruct(node)
  if (banned) {
    report(node, banned)
    return
  }
  if (node.type === 'CallExpression') {
    const callee = childOf(node, 'callee')
    if (callee && ['ArrowFunctionExpression', 'FunctionExpression'].includes(callee.type)) {
      for (const argument of childrenOf(node, 'arguments')) walkEvaluated(argument, report)
      const body = childOf(callee, 'body')
      if (body?.type === 'BlockStatement') {
        for (const statement of childrenOf(body, 'body')) scanEvaluated(statement, report)
      } else if (body) {
        scanEvaluated(body, report)
      }
      return
    }
  }
  if (isFunctionLike(node)) return
  forEachChild(node, (child) => scanEvaluated(child, report))
}

/** Scan a top-level statement whose expression runs while the bundle loads. */
function scanStatement(statement: Node, report: Report): void {
  if (statement.type === 'VariableDeclaration') {
    for (const declaration of childrenOf(statement, 'declarations')) {
      const init = childOf(declaration, 'init')
      if (init) scanEvaluated(init, report)
    }
    return
  }
  if (statement.type === 'ExpressionStatement') {
    const expression = childOf(statement, 'expression')
    if (expression) scanEvaluated(expression, report)
  }
}

const lineOf = (source: string, offset: number): number => {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1
  }
  return line
}

function scanSource(source: string, file = '<fixture>.ts'): Violation[] {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] })
    .program as unknown as Node
  const violations: Violation[] = []
  const report: Report = (node, construct) => {
    const start = node.start ?? 0
    const end = node.end ?? start
    violations.push({
      file: relative(BACKEND_SRC, file),
      line: lineOf(source, start),
      construct,
      snippet: source.slice(start, end).split('\n')[0]!.slice(0, 120),
    })
  }

  for (const statement of childrenOf(program, 'body')) {
    // `export const x = …` is a VariableDeclaration wrapped in an export — the
    // initializer still runs at load, exactly as in the unexported form.
    if (statement.type === 'ExportNamedDeclaration') {
      const declaration = childOf(statement, 'declaration')
      if (declaration) scanStatement(declaration, report)
      continue
    }
    // `export default function`/`class` declare a value; only an exported
    // *expression* (`export default init()`) is evaluated here.
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = childOf(statement, 'declaration')
      if (declaration && declaration.type !== 'ClassDeclaration' && !isFunctionLike(declaration)) {
        scanEvaluated(declaration, report)
      }
      continue
    }
    if (statement.type === 'TSExportAssignment') {
      const expression = childOf(statement, 'expression')
      if (expression) scanEvaluated(expression, report)
      continue
    }
    scanStatement(statement, report)
  }
  return violations
}

function scanFile(file: string): Violation[] {
  return scanSource(readFileSync(file, 'utf8'), file)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...sourceFiles(join(dir, entry.name)))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

describe('Worker bundle: no workerd-hostile work at module scope (#523 review B2)', () => {
  it('evaluates no randomness, timers or IO while the bundle loads', () => {
    const files = sourceFiles(BACKEND_SRC)
    // The walk must actually see the tree; an empty scan would prove nothing.
    expect(files.length).toBeGreaterThan(50)

    const violations = files.flatMap(scanFile)
    const detail = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.construct} (${v.snippet})`)
      .join('\n')
    expect(
      violations,
      violations.length === 0
        ? ''
        : `module-scope work that workerd forbids during bundle evaluation:\n${detail}\n\n` +
            'Move it inside the function/handler that uses it: workerd refuses randomness,\n' +
            'timers and IO in the global scope, and one such call stops the whole Worker.'
    ).toEqual([])
  })
})

// The scan replaced the TypeScript compiler API with @babel/parser, so the shapes
// that caused the outage are pinned here: a scanner that silently stopped
// matching would leave the guard green and useless.
describe('Worker bundle guard: scanner self-check', () => {
  const constructs = (source: string): string[] =>
    scanSource(source).map((violation) => violation.construct)

  it.each([
    ['new AbortController()', 'const controller = new AbortController()'],
    ['new Request()', 'const request = new Request("https://example.com")'],
    ['crypto.*', 'crypto.randomUUID()'],
    ['Math.random()', 'const n = Math.random()'],
    ['performance.now()', 'const started = performance.now()'],
    ['fetch()', 'fetch("https://example.com")'],
    ['setTimeout()', 'setTimeout(() => {}, 0)'],
    ['AbortSignal.timeout()', 'const signal = AbortSignal.timeout(1000)'],
  ])('reports %s at module scope', (construct, source) => {
    expect(constructs(source)).toContain(construct)
  })

  it('reports exports the bundler still evaluates', () => {
    expect(constructs('export const controller = new AbortController()')).toContain(
      'new AbortController()'
    )
    expect(constructs('export default new AbortController()')).toContain('new AbortController()')
  })

  it('reports values nested inside a module-scope initializer', () => {
    expect(constructs('const config = { seed: crypto.randomUUID() }')).toContain('crypto.*')
  })

  it('reports work inside a module-scope IIFE', () => {
    expect(constructs(';(function () { new Request("/x") })()')).toContain('new Request()')
    expect(constructs(';(() => { return Math.random() })()')).toContain('Math.random()')
  })

  it('leaves per-call code alone', () => {
    expect(constructs('export function handler() { return new AbortController() }')).toEqual([])
    expect(constructs('const make = () => new AbortController()')).toEqual([])
    expect(constructs('const K = class { m() { return fetch("/x") } }')).toEqual([])
    expect(constructs('const o = { run() { return fetch("/x") } }')).toEqual([])
    expect(constructs('const xs = [1].map((value) => value + Math.random())')).toEqual([])
  })

  it('reports the line the construct sits on', () => {
    const [violation] = scanSource('const a = 1\nconst b = new AbortController()\n')
    expect(violation?.line).toBe(2)
  })

  it('fails loudly instead of scanning nothing', () => {
    expect(() => scanSource('const = broken(')).toThrow()
  })
})
